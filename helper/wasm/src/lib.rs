use std::collections::{HashMap, HashSet};
use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use base64::Engine;
use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, UtcOffset};
use typst::Library;
use typst::diag::{FileError, FileResult, PackageError, Severity, SourceDiagnostic};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::introspection::PagedPosition;
use typst::layout::{Abs, Point};
use typst::syntax::package::PackageSpec;
use typst::syntax::{FileId, RootedPath, Side, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook, FontInfo};
use typst::utils::LazyHash;
use typst::{LibraryExt, World, WorldExt};
use typst_ide::{
    CompletionKind, Definition, IdeWorld, Jump, autocomplete, definition, jump_from_click,
    jump_from_cursor,
};
use typst_kit::fonts::{FontSource, FontStore};
use typst_layout::PagedDocument;
use typst_pdf::PdfOptions;
use wasm_bindgen::prelude::*;

/// The wire types the plugin and the compiler agree on.
pub mod protocol;

use protocol::{
    ClickRequest, ClickResponse, CompleteRequest, CompleteResponse, CompletionItem,
    DefinitionRequest, DefinitionResponse, Diagnostic, ForwardRequest, ForwardResponse,
    PageDimensions, RenderedPosition,
};

/// Typst's default text family and math face, vendored from typst-assets 0.15.1.
/// Libertinus Serif is under the SIL Open Font License 1.1; New Computer Modern
/// Math is under the GUST Font License.
const EMBEDDED_FONTS: [&[u8]; 7] = [
    include_bytes!("../assets/LibertinusSerif-Regular.otf"),
    include_bytes!("../assets/LibertinusSerif-Italic.otf"),
    include_bytes!("../assets/LibertinusSerif-Bold.otf"),
    include_bytes!("../assets/LibertinusSerif-BoldItalic.otf"),
    include_bytes!("../assets/LibertinusSerif-Semibold.otf"),
    include_bytes!("../assets/LibertinusSerif-SemiboldItalic.otf"),
    include_bytes!("../assets/NewCMMath-Book.otf"),
];

const PROTOCOL_VERSION: u32 = 6;
const TYPST_VERSION: &str = "0.15.1";
const MAX_VAULT_FILE_BYTES: usize = 50 * 1024 * 1024;
const MAX_TOTAL_INPUT_BYTES: usize = 70 * 1024 * 1024;
const MAX_PDF_BYTES: usize = 50 * 1024 * 1024;
const MAX_PDF_PAGES: usize = 1_000;
// PDF's default user space conventionally supports page edges up to 200 inches.
// This bounds geometry only; final output bytes keep their post-export limit.
const MAX_PDF_PAGE_EDGE_POINTS: f64 = 14_400.0;
const MAX_DEPENDENCIES: usize = 10_000;
const MAX_FONT_FILE_BYTES: usize = 64 * 1024 * 1024;
const MAX_FONT_FACES: usize = 20_000;
const MAX_FONT_PATH_BYTES: usize = 4_096;
/// Typst offers every symbol name in math mode, a few thousand entries. The cap
/// only guards against an unbounded response; it sits above that list so a
/// normal request is never truncated.
const MAX_COMPLETIONS: usize = 8_192;
/// The live buffer travels with every completion request, so it carries its own
/// bound rather than riding on the compile path's per-file limit; a Typst source
/// a person edits by hand is orders of magnitude below this.
const MAX_COMPLETION_SOURCE_BYTES: usize = 2 * 1024 * 1024;

/// The host's wall clock at the start of a compile. The compiler has neither a
/// clock nor a timezone database of its own, so the host samples both the
/// instant and its own UTC offset; sampling them once per compile also keeps
/// `datetime.today()` stable across the input-fetch retries of a single
/// revision.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Clock {
    /// Milliseconds since the Unix epoch, UTC.
    pub now_ms: i64,
    /// Minutes to add to UTC to reach the host's local time.
    pub local_offset_minutes: i32,
}

impl Clock {
    fn today(&self, offset: Option<Duration>) -> Option<Datetime> {
        let offset_seconds = match offset {
            None => self.local_offset_minutes.checked_mul(60)?,
            Some(offset) => {
                let seconds = offset.seconds().trunc();
                // `as` saturates and turns NaN into zero, so screen the value
                // before casting; `UtcOffset` then rejects anything a whole day
                // or more from UTC, as typst-kit's own `today` does.
                if !seconds.is_finite() || seconds.abs() >= 86_400.0 {
                    return None;
                }
                seconds as i32
            }
        };
        let local = OffsetDateTime::from_unix_timestamp(self.now_ms.div_euclid(1_000))
            .ok()?
            .to_offset(UtcOffset::from_whole_seconds(offset_seconds).ok()?);
        Datetime::from_ymd(local.year(), u8::from(local.month()), local.day())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInput {
    pub path: String,
    pub contents_base64: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileRequest {
    pub entry: String,
    pub revision: u64,
    pub clock: Clock,
    pub files: Vec<FileInput>,
    /// Files of already-installed local packages, keyed
    /// `{namespace}/{name}/{version}/{path}`. The browser compiler streams these
    /// from the host instead; this field is the in-process equivalent.
    #[serde(default)]
    pub packages: Vec<FileInput>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileResult {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub revision: u64,
    pub pdf_base64: String,
    #[serde(skip)]
    pdf: Vec<u8>,
    pub pdf_bytes: usize,
    pub dependencies: Vec<String>,
    pub diagnostics: Vec<Diagnostic>,
    pub pages: Vec<PageDimensions>,
}

type Loader = Box<dyn Fn(&str) -> FileResult<Bytes> + Send + Sync>;
/// Reads one file of an already-installed local package, keyed
/// `{namespace}/{name}/{version}/{path}`. Package files live on the host outside
/// the vault, so they travel on a channel of their own: asking the project
/// loader for them would let a package spec address a vault file that happens to
/// share the key, and vice versa.
type PackageLoader = Box<dyn Fn(&str) -> FileResult<Bytes> + Send + Sync>;
type FontLoader = Arc<dyn Fn(&str) -> Option<Bytes> + Send + Sync>;

#[derive(Clone)]
struct RegisteredFont {
    path: String,
    index: u32,
    info: FontInfo,
}

#[derive(Default)]
struct FontCatalog {
    fonts: Vec<RegisteredFont>,
    paths: HashSet<String>,
}

fn shared_font_catalog() -> Arc<RwLock<FontCatalog>> {
    static CATALOG: OnceLock<Arc<RwLock<FontCatalog>>> = OnceLock::new();
    Arc::clone(CATALOG.get_or_init(Default::default))
}

struct HostFontSource {
    path: String,
    index: u32,
    loader: FontLoader,
}

impl FontSource for HostFontSource {
    fn load(&self) -> Option<Font> {
        (self.loader)(&self.path).and_then(|bytes| Font::new(bytes, self.index))
    }
}

struct InMemoryWorld {
    main: FileId,
    clock: Clock,
    library: LazyHash<Library>,
    fonts: FontStore,
    loader: Loader,
    package_loader: PackageLoader,
    sources: RwLock<HashMap<FileId, Source>>,
    inputs: Mutex<InputCache>,
}

#[derive(Default)]
struct InputCache {
    files: HashMap<FileId, Bytes>,
    bytes: usize,
}

impl InMemoryWorld {
    fn new(
        entry: &str,
        clock: Clock,
        loader: Loader,
        package_loader: PackageLoader,
        registered_fonts: &[RegisteredFont],
        font_loader: FontLoader,
    ) -> Result<Self, String> {
        let entry = normalize_path(entry)?;
        let vpath = VirtualPath::new(entry).map_err(|error| error.to_string())?;
        let main = FileId::new(RootedPath::new(VirtualRoot::Project, vpath));
        // Embedded defaults lead the catalog so a matching system face cannot
        // change the output of the same source across machines.
        let mut fonts = FontStore::new();
        for bytes in EMBEDDED_FONTS {
            fonts.extend(Font::iter(Bytes::new(bytes)).map(|font| {
                let info = font.info().clone();
                (font, info)
            }));
        }
        for font in registered_fonts {
            fonts.push((
                HostFontSource {
                    path: font.path.clone(),
                    index: font.index,
                    loader: Arc::clone(&font_loader),
                },
                font.info.clone(),
            ));
        }
        Ok(Self {
            main,
            clock,
            library: LazyHash::new(Library::builder().build()),
            fonts,
            loader,
            package_loader,
            sources: RwLock::new(HashMap::new()),
            inputs: Mutex::new(InputCache::default()),
        })
    }

    /// The compilation-root-relative path of a project file. Package files have
    /// no such path, so every caller that speaks in vault terms — inverse search
    /// and the dependency list the host watches — drops them here.
    fn project_path(id: FileId) -> FileResult<String> {
        if !matches!(id.root(), VirtualRoot::Project) {
            return Err(FileError::AccessDenied);
        }
        normalize_path(id.vpath().get_without_slash())
            .map_err(|message| FileError::Other(Some(message.into())))
    }

    fn relative_source_path(&self, id: FileId) -> Option<String> {
        (id.vpath().extension() == Some("typ"))
            .then(|| Self::project_path(id).ok())
            .flatten()
    }

    fn dependencies(&self) -> Vec<String> {
        let mut paths = self
            .inputs
            .lock()
            .unwrap()
            .files
            .keys()
            .filter_map(|id| Self::project_path(*id).ok())
            .collect::<Vec<_>>();
        paths.sort();
        paths
    }

    fn load(&self, id: FileId) -> FileResult<Bytes> {
        let mut cache = self.inputs.lock().unwrap();
        if let Some(bytes) = cache.files.get(&id) {
            return Ok(bytes.clone());
        }
        let bytes = match id.root() {
            VirtualRoot::Project => (self.loader)(&Self::project_path(id)?)?,
            VirtualRoot::Package(spec) => {
                // `VirtualPath` has already normalized `.`, `..`, and
                // backslashes away, so the key can only name a file inside the
                // package directory the host resolves.
                let file = id.vpath().get_without_slash();
                if file.is_empty() {
                    return Err(FileError::IsDirectory);
                }
                (self.package_loader)(&package_key(spec, file))
                    .map_err(|error| package_error(spec, file, error))?
            }
        };
        // Package bytes share the vault's per-file and per-compile budgets, so
        // an import cannot widen how many host bytes one document may read.
        let (total, _) = validate_input_bounds(bytes.len(), cache.bytes, cache.files.len())
            .map_err(|message| FileError::Other(Some(message.into())))?;
        cache.bytes = total;
        cache.files.insert(id, bytes.clone());
        Ok(bytes)
    }
}

fn package_key(spec: &PackageSpec, file: &str) -> String {
    format!("{}/{}/{}/{}", spec.namespace, spec.name, spec.version, file)
}

/// Typst reads a package's `typst.toml` before any of its sources, so a failure
/// there means the package directory itself is absent. That is the case worth
/// naming: Typstian resolves packages only from files the user already has on
/// disk and never fetches one, so "file not found" would send the reader looking
/// for the wrong problem.
fn package_error(spec: &PackageSpec, file: &str, error: FileError) -> FileError {
    if file != "typst.toml" {
        return error;
    }
    FileError::Package(PackageError::Other(Some(
        format!(
            "{spec} is not installed locally, and Typstian never downloads packages; \
             install it with the Typst CLI first"
        )
        .into(),
    )))
}

fn validate_input_bounds(
    file_bytes: usize,
    cached_bytes: usize,
    dependencies: usize,
) -> Result<(usize, usize), String> {
    if file_bytes > MAX_VAULT_FILE_BYTES {
        return Err(format!(
            "vault file exceeds {MAX_VAULT_FILE_BYTES} byte limit"
        ));
    }
    if dependencies >= MAX_DEPENDENCIES {
        return Err(format!(
            "compile exceeds {MAX_DEPENDENCIES} dependency limit"
        ));
    }
    let total = cached_bytes
        .checked_add(file_bytes)
        .filter(|total| *total <= MAX_TOTAL_INPUT_BYTES)
        .ok_or_else(|| format!("compile inputs exceed {MAX_TOTAL_INPUT_BYTES} byte limit"))?;
    Ok((total, dependencies + 1))
}

fn ensure_pdf_size(pdf_bytes: usize) -> Result<(), String> {
    (pdf_bytes <= MAX_PDF_BYTES)
        .then_some(())
        .ok_or_else(|| format!("generated PDF exceeds {MAX_PDF_BYTES} byte limit"))
}

impl World for InMemoryWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        self.fonts.book()
    }

    fn main(&self) -> FileId {
        self.main
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        if let Some(source) = self.sources.read().unwrap().get(&id) {
            return Ok(source.clone());
        }
        if id.vpath().extension() != Some("typ") {
            return Err(FileError::NotSource);
        }
        let bytes = self.load(id)?;
        let text = std::str::from_utf8(&bytes)
            .map_err(|error| FileError::Other(Some(error.to_string().into())))?;
        let source = Source::new(id, text.into());
        self.sources.write().unwrap().insert(id, source.clone());
        Ok(source)
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        self.load(id)
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.fonts.font(index)
    }

    fn today(&self, offset: Option<Duration>) -> Option<Datetime> {
        self.clock.today(offset)
    }
}

impl IdeWorld for InMemoryWorld {
    fn upcast(&self) -> &dyn World {
        self
    }
}

fn normalize_path(path: &str) -> Result<String, String> {
    if path.is_empty() || path.starts_with('/') || path.contains('\\') {
        return Err(format!("invalid vault-relative path: {path}"));
    }
    let mut normalized = Vec::new();
    for component in path.split('/') {
        match component {
            "" | "." => {}
            ".." => return Err(format!("path escapes vault root: {path}")),
            value => normalized.push(value),
        }
    }
    if normalized.is_empty() {
        return Err(format!("invalid vault-relative path: {path}"));
    }
    Ok(normalized.join("/"))
}

fn decode_inputs(inputs: Vec<FileInput>) -> Result<HashMap<String, Bytes>, String> {
    let mut decoded = HashMap::new();
    for file in inputs {
        let path = normalize_path(&file.path)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(file.contents_base64)
            .map_err(|error| format!("invalid base64 for {path}: {error}"))?;
        if decoded.insert(path.clone(), Bytes::new(bytes)).is_some() {
            return Err(format!("duplicate file: {path}"));
        }
    }
    Ok(decoded)
}

fn map_diagnostic(world: &InMemoryWorld, diagnostic: SourceDiagnostic) -> Diagnostic {
    let location = diagnostic.span.id().and_then(|id| {
        let file = world.relative_source_path(id)?;
        let source = world.source(id).ok()?;
        let range = world.range(diagnostic.span)?;
        let lines = source.lines();
        let line = lines.byte_to_line(range.start)?;
        let line_start = lines.line_to_byte(line)?;
        let column = source.text()[line_start..range.start]
            .encode_utf16()
            .count();
        Some((file, line + 1, column + 1))
    });
    Diagnostic {
        file: location.as_ref().map(|value| value.0.clone()),
        line: location.as_ref().map(|value| value.1),
        column: location.map(|value| value.2),
        severity: match diagnostic.severity {
            Severity::Error => "error".into(),
            Severity::Warning => "warning".into(),
        },
        message: diagnostic.message.to_string(),
    }
}

fn protocol_json(value: impl Serialize, request_type: &str) -> Result<String, JsValue> {
    let mut value =
        serde_json::to_value(value).map_err(|error| JsValue::from_str(&error.to_string()))?;
    if let Some(object) = value.as_object_mut() {
        if let Some(status) = object.remove("status") {
            if status == "invalid-request" {
                object.insert("type".into(), "error".into());
                object.insert("requestType".into(), request_type.into());
                object.insert("code".into(), "invalid-request".into());
                object.insert(
                    "message".into(),
                    format!("Invalid {request_type} request").into(),
                );
            } else {
                object.insert("type".into(), status);
            }
        }
        if let Some(expected) = object.remove("expected") {
            object.insert("expectedRevision".into(), expected);
        }
    }
    serde_json::to_string(&value).map_err(|error| JsValue::from_str(&error.to_string()))
}

/// The longest common prefix of two strings that ends on a character boundary
/// in both. Stopping mid-character would make every offset past it meaningless.
fn common_prefix(live: &str, snapshot: &str) -> usize {
    let mut length = live
        .as_bytes()
        .iter()
        .zip(snapshot.as_bytes())
        .take_while(|(left, right)| left == right)
        .count();
    while length > 0 && !(live.is_char_boundary(length) && snapshot.is_char_boundary(length)) {
        length -= 1;
    }
    length
}

/// The longest common suffix that neither overlaps `prefix` nor splits a
/// character.
fn common_suffix(live: &str, snapshot: &str, prefix: usize) -> usize {
    let mut length = live
        .as_bytes()
        .iter()
        .rev()
        .zip(snapshot.as_bytes().iter().rev())
        .take_while(|(left, right)| left == right)
        .count()
        .min(live.len().min(snapshot.len()) - prefix);
    while length > 0
        && !(live.is_char_boundary(live.len() - length)
            && snapshot.is_char_boundary(snapshot.len() - length))
    {
        length -= 1;
    }
    length
}

/// How the buffer the user is typing in lines up with the snapshot the session
/// retained. Completions are computed in snapshot coordinates, so a live cursor
/// only means something there when the two texts differ by a single splice that
/// ends at the cursor: everything before and after that splice is shared, so the
/// cursor names the same point in both. Anything else is refused rather than
/// guessed — a cursor mapped onto the wrong syntax node describes the wrong
/// document.
struct CursorMapping {
    /// The cursor in snapshot coordinates.
    snapshot_cursor: usize,
    /// Where the splice starts. Offsets up to here mean the same in both texts.
    prefix: usize,
}

impl CursorMapping {
    /// Requires a cursor already known to be a character boundary of `live`.
    fn resolve(live: &str, snapshot: &str, cursor: usize) -> Option<Self> {
        if live == snapshot {
            return Some(Self {
                snapshot_cursor: cursor,
                prefix: snapshot.len(),
            });
        }
        let prefix = common_prefix(live, snapshot);
        let suffix = common_suffix(live, snapshot, prefix);
        if cursor != live.len() - suffix {
            return None;
        }
        let snapshot_cursor = snapshot.len() - suffix;
        (snapshot_cursor >= prefix && snapshot.is_char_boundary(snapshot_cursor)).then_some(Self {
            snapshot_cursor,
            prefix,
        })
    }

    /// A snapshot offset in the requesting buffer's coordinates. An offset past
    /// the splice start has no image: the text it named is exactly the text the
    /// user has since replaced.
    fn to_live(&self, offset: usize) -> Option<usize> {
        (offset <= self.prefix).then_some(offset)
    }
}

/// The wire name of a completion kind. Typst's own `Serialize` would nest the
/// symbol variant's payload, and the editor only needs a flat tag to pick an
/// icon.
fn completion_kind(kind: &CompletionKind) -> &'static str {
    match kind {
        CompletionKind::Syntax => "syntax",
        CompletionKind::Func => "func",
        CompletionKind::Type => "type",
        CompletionKind::Param => "param",
        CompletionKind::Constant => "constant",
        CompletionKind::Path => "path",
        CompletionKind::Package => "package",
        CompletionKind::Label => "label",
        CompletionKind::Font => "font",
        CompletionKind::Symbol(_) => "symbol",
    }
}

#[derive(Default)]
pub struct Session {
    revision: Option<u64>,
    world: Option<InMemoryWorld>,
    document: Option<PagedDocument>,
    catalog: Arc<RwLock<FontCatalog>>,
}

impl Session {
    pub fn new() -> Self {
        Self::default()
    }

    fn with_catalog(catalog: Arc<RwLock<FontCatalog>>) -> Self {
        Self {
            catalog,
            ..Self::default()
        }
    }

    pub fn register_font(&mut self, path: &str, bytes: &[u8]) -> Result<usize, String> {
        if path.is_empty() || path.len() > MAX_FONT_PATH_BYTES {
            return Err(format!(
                "font path must contain 1..={MAX_FONT_PATH_BYTES} bytes"
            ));
        }
        let mut catalog = self
            .catalog
            .write()
            .map_err(|_| "system font catalog lock poisoned".to_string())?;
        if catalog.paths.contains(path) {
            return Ok(0);
        }
        if bytes.is_empty() || bytes.len() > MAX_FONT_FILE_BYTES {
            return Err(format!(
                "font file must contain 1..={MAX_FONT_FILE_BYTES} bytes"
            ));
        }
        let fonts = Font::iter(Bytes::new(bytes.to_vec())).collect::<Vec<_>>();
        if fonts.is_empty() {
            return Err("invalid or unsupported font file".into());
        }
        if catalog.fonts.len() + fonts.len() > MAX_FONT_FACES {
            return Err(format!(
                "registered fonts exceed {MAX_FONT_FACES} face limit"
            ));
        }
        let count = fonts.len();
        catalog
            .fonts
            .extend(fonts.into_iter().map(|font| RegisteredFont {
                path: path.into(),
                index: font.index(),
                info: font.info().clone(),
            }));
        catalog.paths.insert(path.into());
        Ok(count)
    }

    pub fn compile(&mut self, request: CompileRequest) -> Result<CompileResult, String> {
        let files = decode_inputs(request.files)?;
        let packages = decode_inputs(request.packages)?;
        let mut result = self.compile_with_loader(
            request.entry,
            request.revision,
            request.clock,
            Box::new(move |path| {
                files
                    .get(path)
                    .cloned()
                    .ok_or_else(|| FileError::NotFound(path.into()))
            }),
            Box::new(move |key| {
                packages
                    .get(key)
                    .cloned()
                    .ok_or_else(|| FileError::NotFound(key.into()))
            }),
            Arc::new(|_| None),
        )?;
        if !result.pdf.is_empty() {
            result.pdf_base64 = base64::engine::general_purpose::STANDARD.encode(&result.pdf);
        }
        Ok(result)
    }

    fn compile_with_loader(
        &mut self,
        entry: String,
        revision: u64,
        clock: Clock,
        loader: Loader,
        package_loader: PackageLoader,
        font_loader: FontLoader,
    ) -> Result<CompileResult, String> {
        let registered_fonts = self
            .catalog
            .read()
            .map_err(|_| "system font catalog lock poisoned".to_string())?
            .fonts
            .clone();
        let world = InMemoryWorld::new(
            &entry,
            clock,
            loader,
            package_loader,
            &registered_fonts,
            font_loader,
        )?;
        let result = typst::compile::<PagedDocument>(&world);
        let mut diagnostics = result
            .warnings
            .into_iter()
            .map(|warning| {
                let mut mapped = map_diagnostic(&world, warning);
                mapped.severity = "warning".into();
                mapped
            })
            .collect::<Vec<_>>();
        let document = match result.output {
            Ok(document) => document,
            Err(errors) => {
                diagnostics.extend(
                    errors
                        .into_iter()
                        .map(|error| map_diagnostic(&world, error)),
                );
                return Ok(CompileResult {
                    kind: "compiled",
                    revision,
                    pdf_base64: String::new(),
                    pdf: Vec::new(),
                    pdf_bytes: 0,
                    dependencies: world.dependencies(),
                    diagnostics,
                    pages: Vec::new(),
                });
            }
        };
        if document.pages().len() > MAX_PDF_PAGES {
            return Err(format!("document exceeds {MAX_PDF_PAGES} page limit"));
        }
        if document.pages().iter().any(|page| {
            page.frame.width().to_pt() > MAX_PDF_PAGE_EDGE_POINTS
                || page.frame.height().to_pt() > MAX_PDF_PAGE_EDGE_POINTS
        }) {
            return Err(format!(
                "document page exceeds {MAX_PDF_PAGE_EDGE_POINTS} point edge limit"
            ));
        }
        let pdf = typst_pdf::pdf(&document, &PdfOptions::default())
            .map_err(|errors| format!("PDF export failed: {errors:?}"))?;
        ensure_pdf_size(pdf.len())?;
        let pages = document
            .pages()
            .iter()
            .map(|page| PageDimensions {
                width_pt: page.frame.width().to_pt(),
                height_pt: page.frame.height().to_pt(),
            })
            .collect();
        let pdf_bytes = pdf.len();
        let compiled = CompileResult {
            kind: "compiled",
            revision,
            pdf_base64: String::new(),
            pdf,
            pdf_bytes,
            dependencies: world.dependencies(),
            diagnostics,
            pages,
        };
        self.revision = Some(revision);
        self.world = Some(world);
        self.document = Some(document);
        Ok(compiled)
    }

    pub fn click(&self, request: ClickRequest) -> ClickResponse {
        let Some(revision) = self.revision else {
            return ClickResponse::InvalidRequest {
                revision: request.revision,
            };
        };
        if request.revision != revision {
            return ClickResponse::StaleRevision { expected: revision };
        }
        let (Some(world), Some(document), Some(page)) = (
            self.world.as_ref(),
            self.document.as_ref(),
            NonZeroUsize::new(request.page),
        ) else {
            return ClickResponse::InvalidRequest { revision };
        };
        if request.page > document.pages().len()
            || !request.x_pt.is_finite()
            || !request.y_pt.is_finite()
            || request.x_pt < 0.0
            || request.y_pt < 0.0
        {
            return ClickResponse::InvalidRequest { revision };
        }
        let position = PagedPosition {
            page,
            point: Point::new(Abs::pt(request.x_pt), Abs::pt(request.y_pt)),
        };
        match jump_from_click(world, document, &position) {
            Some(Jump::File(id, byte_offset)) => match world.relative_source_path(id) {
                Some(path) => ClickResponse::Source {
                    revision,
                    path,
                    byte_offset,
                },
                None => ClickResponse::NoSource { revision },
            },
            _ => ClickResponse::NoSource { revision },
        }
    }

    /// The snapshot of a project source that produced the visible PDF. Every
    /// cursor-driven request answers from this snapshot rather than the buffer
    /// the user is currently typing in, so none of them can trigger a compile of
    /// its own.
    fn retained_source(world: &InMemoryWorld, source: &str) -> Option<Source> {
        let path = normalize_path(source).ok()?;
        let vpath = VirtualPath::new(path).ok()?;
        let id = FileId::new(RootedPath::new(VirtualRoot::Project, vpath));
        world.source(id).ok()
    }

    pub fn complete(&self, request: CompleteRequest) -> CompleteResponse {
        let Some(revision) = self.revision else {
            return CompleteResponse::InvalidRequest {
                revision: request.revision,
            };
        };
        if request.revision != revision {
            return CompleteResponse::StaleRevision { expected: revision };
        }
        let (Some(world), Some(document)) = (self.world.as_ref(), self.document.as_ref()) else {
            return CompleteResponse::InvalidRequest { revision };
        };
        if request.source_text.len() > MAX_COMPLETION_SOURCE_BYTES
            || request.byte_offset > request.source_text.len()
            || !request.source_text.is_char_boundary(request.byte_offset)
        {
            return CompleteResponse::InvalidRequest { revision };
        }
        let Some(source) = Self::retained_source(world, &request.source) else {
            return CompleteResponse::InvalidRequest { revision };
        };
        // The cursor belongs to the buffer the user is typing in; the retained
        // snapshot may be a few keystrokes behind it.
        let Some(mapping) =
            CursorMapping::resolve(&request.source_text, source.text(), request.byte_offset)
        else {
            return CompleteResponse::NoCompletions { revision };
        };
        // The document carries the labels and the values of evaluated
        // expressions, so passing it is what makes `@ref` and field completions
        // more than syntax guesses.
        let Some((offset, items)) = autocomplete(
            world,
            Some(document),
            &source,
            mapping.snapshot_cursor,
            request.explicit,
        ) else {
            return CompleteResponse::NoCompletions { revision };
        };
        let Some(byte_offset) = mapping.to_live(offset) else {
            return CompleteResponse::NoCompletions { revision };
        };
        if items.is_empty() {
            return CompleteResponse::NoCompletions { revision };
        }
        CompleteResponse::Completions {
            revision,
            byte_offset,
            completions: items
                .into_iter()
                .take(MAX_COMPLETIONS)
                .map(|item| CompletionItem {
                    kind: completion_kind(&item.kind).into(),
                    label: item.label.into(),
                    apply: item.apply.map(Into::into),
                    detail: item.detail.map(Into::into),
                })
                .collect(),
        }
    }

    pub fn definition(&self, request: DefinitionRequest) -> DefinitionResponse {
        let Some(revision) = self.revision else {
            return DefinitionResponse::InvalidRequest {
                revision: request.revision,
            };
        };
        if request.revision != revision {
            return DefinitionResponse::StaleRevision { expected: revision };
        }
        let (Some(world), Some(document)) = (self.world.as_ref(), self.document.as_ref()) else {
            return DefinitionResponse::InvalidRequest { revision };
        };
        if request.source_text.len() > MAX_COMPLETION_SOURCE_BYTES
            || request.byte_offset > request.source_text.len()
            || !request.source_text.is_char_boundary(request.byte_offset)
        {
            return DefinitionResponse::InvalidRequest { revision };
        }
        let Some(source) = Self::retained_source(world, &request.source) else {
            return DefinitionResponse::InvalidRequest { revision };
        };
        let Some(mapping) =
            CursorMapping::resolve(&request.source_text, source.text(), request.byte_offset)
        else {
            return DefinitionResponse::NoDefinition { revision };
        };
        let Some(target) = definition(
            world,
            Some(document),
            &source,
            mapping.snapshot_cursor,
            Side::Before,
        )
        .or_else(|| {
            definition(
                world,
                Some(document),
                &source,
                mapping.snapshot_cursor,
                Side::After,
            )
        }) else {
            return DefinitionResponse::NoDefinition { revision };
        };
        let location = match target {
            Definition::Span(span) => span.id().and_then(|id| {
                let path = world.relative_source_path(id)?;
                let target_source = world.source(id).ok()?;
                let mut byte_offset = world.range(span)?.start;
                if byte_offset > target_source.text().len()
                    || !target_source.text().is_char_boundary(byte_offset)
                {
                    return None;
                }
                if path == request.source {
                    byte_offset = mapping.to_live(byte_offset)?;
                }
                Some((path, byte_offset))
            }),
            Definition::File(id) => world.relative_source_path(id).map(|path| (path, 0)),
            Definition::Std(_) => None,
        };
        match location {
            Some((path, byte_offset)) => DefinitionResponse::Source {
                revision,
                path,
                byte_offset,
            },
            None => DefinitionResponse::NoDefinition { revision },
        }
    }

    pub fn forward(&self, request: ForwardRequest) -> ForwardResponse {
        let Some(revision) = self.revision else {
            return ForwardResponse::InvalidRequest {
                revision: request.revision,
            };
        };
        if request.revision != revision {
            return ForwardResponse::StaleRevision { expected: revision };
        }
        let (Some(world), Some(document)) = (self.world.as_ref(), self.document.as_ref()) else {
            return ForwardResponse::InvalidRequest { revision };
        };
        let Some(source) = Self::retained_source(world, &request.source) else {
            return ForwardResponse::InvalidRequest { revision };
        };
        if request.byte_offset > source.text().len()
            || !source.text().is_char_boundary(request.byte_offset)
        {
            return ForwardResponse::InvalidRequest { revision };
        }
        let positions = jump_from_cursor(document, &source, request.byte_offset)
            .into_iter()
            .filter_map(|position| {
                let rendered = RenderedPosition {
                    page: position.page.get(),
                    x_pt: position.point.x.to_pt(),
                    y_pt: position.point.y.to_pt(),
                };
                (rendered.page <= 1000
                    && rendered.x_pt.is_finite()
                    && rendered.y_pt.is_finite()
                    && rendered.x_pt >= 0.0
                    && rendered.y_pt >= 0.0)
                    .then_some(rendered)
            })
            .take(1000)
            .collect::<Vec<_>>();
        if positions.is_empty() {
            ForwardResponse::NoPosition { revision }
        } else {
            ForwardResponse::Positions {
                revision,
                positions,
            }
        }
    }
}

#[cfg(target_arch = "wasm32")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmCompileRequest {
    entry: String,
    revision: u64,
    clock: Clock,
}

/// Wraps a host callback that answers with the bytes of one input file, or with
/// null when it has none. The size check mirrors the world's own bound so an
/// oversized answer never reaches the input cache.
#[cfg(target_arch = "wasm32")]
fn js_loader(callback: js_sys::Function, name: &'static str) -> Loader {
    Box::new(move |path| {
        let value = callback
            .call1(&JsValue::NULL, &JsValue::from_str(path))
            .map_err(|_| FileError::Other(Some(format!("{name} failed for {path}").into())))?;
        if value.is_null() || value.is_undefined() {
            return Err(FileError::NotFound(path.into()));
        }
        let array = js_sys::Uint8Array::new(&value);
        if array.length() as usize > MAX_VAULT_FILE_BYTES {
            return Err(FileError::Other(Some(
                format!("input file exceeds {MAX_VAULT_FILE_BYTES} byte limit").into(),
            )));
        }
        Ok(Bytes::new(array.to_vec()))
    })
}

#[wasm_bindgen]
pub struct TypstianWasmSession {
    inner: Session,
}

#[wasm_bindgen]
impl TypstianWasmSession {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Session::with_catalog(shared_font_catalog()),
        }
    }

    pub fn register_font(&mut self, path: &str, bytes: &[u8]) -> Result<usize, JsValue> {
        self.inner
            .register_font(path, bytes)
            .map_err(|error| JsValue::from_str(&error))
    }

    pub fn environment(&self) -> String {
        serde_json::json!({
            "type": "environment",
            "protocolVersion": PROTOCOL_VERSION,
            "typstVersion": TYPST_VERSION,
        })
        .to_string()
    }

    #[cfg(target_arch = "wasm32")]
    pub fn compile(
        &mut self,
        request_json: &str,
        read_file: &js_sys::Function,
        read_package: &js_sys::Function,
        read_font: &js_sys::Function,
    ) -> Result<JsValue, JsValue> {
        let request: WasmCompileRequest = serde_json::from_str(request_json)
            .map_err(|error| JsValue::from_str(&format!("invalid compile request: {error}")))?;
        let read_font = read_font.clone();
        let result = self
            .inner
            .compile_with_loader(
                request.entry,
                request.revision,
                request.clock,
                js_loader(read_file.clone(), "readFile"),
                js_loader(read_package.clone(), "readPackage"),
                Arc::new(move |path| {
                    let value = read_font
                        .call1(&JsValue::NULL, &JsValue::from_str(path))
                        .ok()?;
                    if value.is_null() || value.is_undefined() {
                        return None;
                    }
                    let array = js_sys::Uint8Array::new(&value);
                    if array.length() as usize > MAX_FONT_FILE_BYTES {
                        return None;
                    }
                    Some(Bytes::new(array.to_vec()))
                }),
            )
            .map_err(|error| JsValue::from_str(&error))?;
        if result.pdf.is_empty() {
            let message = result
                .diagnostics
                .iter()
                .find(|diagnostic| diagnostic.severity == "error")
                .map(|diagnostic| diagnostic.message.as_str())
                .unwrap_or("Typst compilation failed");
            return Ok(JsValue::from_str(
                &serde_json::json!({
                    "type": "error",
                    "requestType": "compile",
                    "revision": result.revision,
                    "code": "compile",
                    "message": message,
                    "dependencies": result.dependencies,
                    "diagnostics": result.diagnostics,
                })
                .to_string(),
            ));
        }

        let response_json = serde_json::json!({
            "type": result.kind,
            "revision": result.revision,
            "pdfBytes": result.pdf_bytes,
            "dependencies": result.dependencies,
            "diagnostics": result.diagnostics,
            "pages": result.pages,
        })
        .to_string();
        let response = js_sys::JSON::parse(&response_json)
            .map_err(|_| JsValue::from_str("failed to encode compile response"))?;
        let pdf = js_sys::Uint8Array::from(result.pdf.as_slice());
        js_sys::Reflect::set(&response, &JsValue::from_str("pdfBuffer"), &pdf.buffer())?;
        Ok(response)
    }

    pub fn jump(&self, request_json: &str) -> Result<String, JsValue> {
        let request = serde_json::from_str(request_json)
            .map_err(|error| JsValue::from_str(&format!("invalid jump request: {error}")))?;
        protocol_json(self.inner.click(request), "jump")
    }

    pub fn complete(&self, request_json: &str) -> Result<String, JsValue> {
        let request = serde_json::from_str(request_json)
            .map_err(|error| JsValue::from_str(&format!("invalid complete request: {error}")))?;
        protocol_json(self.inner.complete(request), "complete")
    }

    pub fn definition(&self, request_json: &str) -> Result<String, JsValue> {
        let request = serde_json::from_str(request_json)
            .map_err(|error| JsValue::from_str(&format!("invalid definition request: {error}")))?;
        protocol_json(self.inner.definition(request), "definition")
    }

    pub fn forward(&self, request_json: &str) -> Result<String, JsValue> {
        let request = serde_json::from_str(request_json)
            .map_err(|error| JsValue::from_str(&format!("invalid forward request: {error}")))?;
        protocol_json(self.inner.forward(request), "forward")
    }
}

#[cfg(test)]
mod font_tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[test]
    fn jump_protocol_serializes_byte_offset_as_camel_case() {
        let response = protocol_json(
            ClickResponse::Source {
                revision: 1,
                path: "main.typ".into(),
                byte_offset: 7,
            },
            "jump",
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_str(&response).unwrap();

        assert_eq!(value["byteOffset"], 7);
        assert!(value.get("byte_offset").is_none());
    }

    #[test]
    fn registered_system_font_is_loaded_only_when_selected() {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(include_str!("../../tests/fixtures/fonts/colr_1.ttf.base64").trim())
            .unwrap();
        let font = Font::iter(Bytes::new(bytes.clone()))
            .next()
            .expect("font fixture should be scannable");
        let family = font.info().family.to_string();
        let source = Bytes::from_string(format!("#set text(font: \"{family}\")\nSystem font"));
        let loads = Arc::new(AtomicUsize::new(0));
        let loads_for_loader = Arc::clone(&loads);
        let font_bytes = Bytes::new(bytes.clone());
        let catalog = Arc::new(RwLock::new(FontCatalog::default()));
        let mut registrar = Session::with_catalog(Arc::clone(&catalog));
        let mut session = Session::with_catalog(catalog);

        assert_eq!(registrar.register_font("system.ttf", &bytes).unwrap(), 1);
        drop(registrar);
        assert_eq!(loads.load(Ordering::SeqCst), 0);
        let compiled = session
            .compile_with_loader(
                "main.typ".into(),
                8,
                Clock {
                    now_ms: 0,
                    local_offset_minutes: 0,
                },
                Box::new(move |path| {
                    (path == "main.typ")
                        .then(|| source.clone())
                        .ok_or_else(|| FileError::NotFound(path.into()))
                }),
                Box::new(|key| Err(FileError::NotFound(key.into()))),
                Arc::new(move |path| {
                    (path == "system.ttf").then(|| {
                        loads_for_loader.fetch_add(1, Ordering::SeqCst);
                        font_bytes.clone()
                    })
                }),
            )
            .expect("fixture compiles");

        assert!(!compiled.pdf.is_empty());
        assert_eq!(loads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn embedded_libertinus_takes_priority_over_a_conflicting_system_face() {
        let bytes = include_bytes!("../assets/LibertinusSerif-Regular.otf").to_vec();
        let source = Bytes::from_string("Default text");
        let loads = Arc::new(AtomicUsize::new(0));
        let loads_for_loader = Arc::clone(&loads);
        let font_bytes = Bytes::new(bytes.clone());
        let catalog = Arc::new(RwLock::new(FontCatalog::default()));
        let mut registrar = Session::with_catalog(Arc::clone(&catalog));
        let mut session = Session::with_catalog(catalog);

        assert_eq!(
            registrar
                .register_font("system-libertinus.otf", &bytes)
                .unwrap(),
            1,
        );
        drop(registrar);
        let compiled = session
            .compile_with_loader(
                "main.typ".into(),
                9,
                Clock {
                    now_ms: 0,
                    local_offset_minutes: 0,
                },
                Box::new(move |path| {
                    (path == "main.typ")
                        .then(|| source.clone())
                        .ok_or_else(|| FileError::NotFound(path.into()))
                }),
                Box::new(|key| Err(FileError::NotFound(key.into()))),
                Arc::new(move |path| {
                    (path == "system-libertinus.otf").then(|| {
                        loads_for_loader.fetch_add(1, Ordering::SeqCst);
                        font_bytes.clone()
                    })
                }),
            )
            .expect("default text compiles");

        assert!(!compiled.pdf.is_empty());
        assert_eq!(loads.load(Ordering::SeqCst), 0);
    }
}

impl Default for TypstianWasmSession {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod cursor_mapping_tests {
    use super::*;

    #[test]
    fn maps_a_cursor_through_an_unchanged_buffer() {
        let mapping = CursorMapping::resolve("café #im", "café #im", 5).unwrap();

        assert_eq!(mapping.snapshot_cursor, 5);
        assert_eq!(mapping.to_live(5), Some(5));
        assert_eq!(mapping.to_live(0), Some(0));
    }

    #[test]
    fn maps_a_cursor_back_across_text_typed_since_the_compile() {
        // `im` typed at the cursor, past a multi-byte character and with
        // untouched text after it.
        let mapping = CursorMapping::resolve("café #im rest", "café # rest", 9).unwrap();

        assert_eq!(mapping.snapshot_cursor, 7);
        // A word starting at or before the splice names the same byte in both.
        assert_eq!(mapping.to_live(6), Some(6));
        assert_eq!(mapping.to_live(7), Some(7));
        // Nothing after it does.
        assert_eq!(mapping.to_live(8), None);
    }

    #[test]
    fn maps_a_cursor_back_across_a_deletion_at_the_cursor() {
        let mapping = CursorMapping::resolve("café # rest", "café #im rest", 7).unwrap();

        assert_eq!(mapping.snapshot_cursor, 9);
        assert_eq!(mapping.to_live(7), Some(7));
        // The word started inside the text the user just deleted.
        assert_eq!(mapping.to_live(8), None);
    }

    #[test]
    fn refuses_a_splice_that_does_not_end_at_the_cursor() {
        // Edited before the cursor, but the edit does not reach it.
        assert!(CursorMapping::resolve("Xcafé #im", "café #im", 9).is_none());
        // Edited after the cursor.
        assert!(CursorMapping::resolve("café #im!", "café #im", 4).is_none());
    }

    #[test]
    fn keeps_the_splice_bounds_on_character_boundaries() {
        // `각` and `가` share their first two bytes, so a byte-wise prefix would
        // stop inside a character and every offset after it would be a lie.
        let mapping = CursorMapping::resolve("가각", "가가", 6).unwrap();

        assert_eq!(mapping.snapshot_cursor, 6);
        assert_eq!(mapping.to_live(3), Some(3));
        assert_eq!(mapping.to_live(4), None);
    }
}

#[cfg(test)]
mod resource_limit_tests {
    use super::*;

    #[test]
    fn rejects_input_before_it_exceeds_any_cache_bound() {
        assert!(validate_input_bounds(MAX_VAULT_FILE_BYTES + 1, 0, 0).is_err());
        assert!(validate_input_bounds(2, MAX_TOTAL_INPUT_BYTES - 1, 0).is_err());
        assert!(validate_input_bounds(1, 0, MAX_DEPENDENCIES).is_err());
        assert_eq!(
            validate_input_bounds(MAX_VAULT_FILE_BYTES, 0, 0).unwrap(),
            (MAX_VAULT_FILE_BYTES, 1)
        );
    }

    #[test]
    fn rejects_pdf_before_base64_expansion() {
        assert!(ensure_pdf_size(MAX_PDF_BYTES + 1).is_err());
        assert!(ensure_pdf_size(MAX_PDF_BYTES).is_ok());
    }
}

#[cfg(test)]
mod clock_tests {
    use super::*;

    fn hours(count: f64) -> Duration {
        Duration::from(time::Duration::seconds((count * 3600.0) as i64))
    }

    #[test]
    fn resolves_the_local_date_when_no_offset_is_requested() {
        // 2026-08-26T22:30:00Z: the 27th nine hours ahead of UTC, and still the
        // 26th nine hours behind, so a flipped sign fails here.
        let clock = Clock {
            now_ms: 1_787_783_400_000,
            local_offset_minutes: 9 * 60,
        };
        assert_eq!(clock.today(None), Datetime::from_ymd(2026, 8, 27));
    }

    #[test]
    fn applies_a_requested_offset_instead_of_the_local_one() {
        // 2026-08-26T22:30:00Z: still the 26th in UTC, the 27th at UTC+9.
        let clock = Clock {
            now_ms: 1_787_783_400_000,
            local_offset_minutes: 0,
        };
        assert_eq!(
            clock.today(Some(hours(0.0))),
            Datetime::from_ymd(2026, 8, 26)
        );
        assert_eq!(
            clock.today(Some(hours(9.0))),
            Datetime::from_ymd(2026, 8, 27)
        );
        assert_eq!(
            clock.today(Some(hours(-23.0))),
            Datetime::from_ymd(2026, 8, 25)
        );
    }

    #[test]
    fn resolves_dates_before_the_epoch_and_across_leap_days() {
        let leap = Clock {
            // 2024-02-29T00:00:00Z
            now_ms: 1_709_164_800_000,
            local_offset_minutes: 0,
        };
        assert_eq!(leap.today(None), Datetime::from_ymd(2024, 2, 29));

        let before_epoch = Clock {
            // 1969-12-31T23:00:00Z
            now_ms: -3_600_000,
            local_offset_minutes: 0,
        };
        assert_eq!(before_epoch.today(None), Datetime::from_ymd(1969, 12, 31));

        // One millisecond before the epoch still belongs to 1969: the seconds
        // must floor, not truncate toward zero.
        let just_before_epoch = Clock {
            now_ms: -1,
            local_offset_minutes: 0,
        };
        assert_eq!(
            just_before_epoch.today(None),
            Datetime::from_ymd(1969, 12, 31)
        );
    }

    #[test]
    fn rejects_an_offset_that_cannot_be_a_timezone() {
        let clock = Clock {
            now_ms: 0,
            local_offset_minutes: 0,
        };
        assert_eq!(clock.today(Some(hours(24.0))), None);
        assert_eq!(clock.today(Some(hours(-24.0))), None);
        assert_eq!(clock.today(Some(hours(f64::from(i32::MAX)))), None);
        assert!(clock.today(Some(hours(23.0))).is_some());
    }
}
