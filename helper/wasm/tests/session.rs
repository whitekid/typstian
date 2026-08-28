use base64::Engine;
use typstian_wasm::protocol::{
    ClickRequest, ClickResponse, CompleteRequest, CompleteResponse, CompletionItem,
    DefinitionRequest, DefinitionResponse, ForwardRequest, ForwardResponse, PageDimensions,
    RenderedPosition, TooltipRequest, TooltipResponse,
};
use typstian_wasm::{Clock, CompileRequest, CompileResult, FileInput, Session};

/// 2026-08-26T22:30:00Z at UTC+9, where the local date (the 27th) differs from
/// the UTC one (the 26th) so an ignored or inverted offset cannot pass. Fixed so
/// compiles stay reproducible.
const CLOCK: Clock = Clock {
    now_ms: 1_787_783_400_000,
    local_offset_minutes: 9 * 60,
};

fn fixture(group: &str, path: &str) -> FileInput {
    let bytes = std::fs::read(format!("../tests/fixtures/{group}/{path}")).unwrap();
    file_input(path, &bytes)
}

/// A file of the locally installed package fixture, keyed the way the compiler
/// asks the host for it: `{namespace}/{name}/{version}/{path}`.
fn package_fixture(key: &str) -> FileInput {
    let bytes = std::fs::read(format!("../tests/fixtures/packages/local/{key}")).unwrap();
    file_input(key, &bytes)
}

fn error_messages(result: &typstian_wasm::CompileResult) -> Vec<&str> {
    result
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.severity == "error")
        .map(|diagnostic| diagnostic.message.as_str())
        .collect()
}

fn file_input(path: &str, bytes: &[u8]) -> FileInput {
    FileInput {
        path: path.into(),
        contents_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    }
}

fn compile_source(source: &str) -> Result<CompileResult, String> {
    Session::new().compile(CompileRequest {
        clock: CLOCK,
        entry: "main.typ".into(),
        revision: 1,
        files: vec![file_input("main.typ", source.as_bytes())],
        packages: Vec::new(),
    })
}

fn project_request(revision: u64) -> CompileRequest {
    CompileRequest {
        clock: CLOCK,
        entry: "main.typ".into(),
        revision,
        files: vec![
            fixture("project", "main.typ"),
            fixture("project", "section.typ"),
            fixture("project", "assets/mark.svg"),
        ],
        packages: Vec::new(),
    }
}

fn first_position(
    session: &Session,
    revision: u64,
    source: &str,
    byte_offset: usize,
) -> Option<RenderedPosition> {
    match session.forward(ForwardRequest {
        revision,
        source: source.into(),
        byte_offset,
    }) {
        ForwardResponse::Positions { positions, .. } => positions.into_iter().next(),
        _ => None,
    }
}

fn click_at(session: &Session, revision: u64, position: RenderedPosition) -> ClickResponse {
    session.click(ClickRequest {
        revision,
        page: position.page,
        x_pt: position.x_pt,
        y_pt: position.y_pt,
    })
}

fn inverse_position(
    session: &Session,
    revision: u64,
    pages: &[PageDimensions],
    expected_path: &str,
    expected_offset: usize,
) -> Option<RenderedPosition> {
    for (page_index, page) in pages.iter().enumerate() {
        for y in 0..page.height_pt.ceil() as usize {
            for x in 0..page.width_pt.ceil() as usize {
                let position = RenderedPosition {
                    page: page_index + 1,
                    x_pt: x as f64 + 0.5,
                    y_pt: y as f64 + 0.5,
                };
                if matches!(
                    click_at(session, revision, position.clone()),
                    ClickResponse::Source {
                        path,
                        byte_offset,
                        ..
                    } if path == expected_path && byte_offset == expected_offset
                ) {
                    return Some(position);
                }
            }
        }
    }
    None
}

#[test]
fn compiles_imports_images_and_both_navigation_directions() {
    let section = std::fs::read("../tests/fixtures/project/section.typ").unwrap();
    let byte_offset = std::str::from_utf8(&section).unwrap().find('한').unwrap();
    let mut session = Session::new();
    let compiled = session
        .compile(project_request(7))
        .expect("fixture compiles");

    assert_eq!(compiled.revision, 7);
    assert!(!compiled.pdf_base64.is_empty());
    assert!(!compiled.pages.is_empty());
    assert!(
        compiled
            .dependencies
            .iter()
            .any(|path| path == "assets/mark.svg"),
        "binary assets are compile dependencies"
    );

    let position = first_position(&session, 7, "section.typ", byte_offset)
        .expect("forward search should find imported Unicode text");
    assert!(matches!(
        click_at(&session, 7, position),
        ClickResponse::Source { path, .. } if path == "section.typ"
    ));
}

#[test]
fn maps_imported_unicode_glyph_to_exact_utf8_byte_offset() {
    let section = std::fs::read("../tests/fixtures/project/section.typ").unwrap();
    let expected = std::str::from_utf8(&section).unwrap().find('한').unwrap();
    let mut session = Session::new();
    let compiled = session
        .compile(project_request(2))
        .expect("fixture compiles");
    let position = inverse_position(&session, 2, &compiled.pages, "section.typ", expected)
        .expect("imported glyph should have an exact inverse-search position");

    assert_eq!(
        click_at(&session, 2, position),
        ClickResponse::Source {
            revision: 2,
            path: "section.typ".into(),
            byte_offset: expected,
        }
    );
}

#[test]
fn rejects_stale_click_revision_without_recompiling() {
    let mut session = Session::new();
    session
        .compile(project_request(10))
        .expect("fixture compiles");

    assert_eq!(
        session.click(ClickRequest {
            revision: 9,
            page: 1,
            x_pt: 10.0,
            y_pt: 10.0,
        }),
        ClickResponse::StaleRevision { expected: 10 }
    );
}

#[test]
fn maps_compile_error_to_exact_source_location() {
    let mut session = Session::new();
    let result = session
        .compile(CompileRequest {
            clock: CLOCK,
            entry: "invalid.typ".into(),
            revision: 11,
            files: vec![fixture("diagnostics", "invalid.typ")],
            packages: Vec::new(),
        })
        .expect("compile diagnostics are a protocol result");

    assert!(result.pdf_base64.is_empty());
    let diagnostic = result.diagnostics.first().expect("at least one diagnostic");
    assert_eq!(diagnostic.file.as_deref(), Some("invalid.typ"));
    assert_eq!(diagnostic.line, Some(2));
    assert_eq!(diagnostic.column, Some(15));
    assert_eq!(diagnostic.severity, "error");
    assert!(!diagnostic.message.is_empty());
}

#[test]
fn maps_diagnostic_column_as_utf16_for_javascript_clients() {
    let mut session = Session::new();
    let result = session
        .compile(CompileRequest {
            clock: CLOCK,
            entry: "astral.typ".into(),
            revision: 14,
            files: vec![fixture("diagnostics", "astral.typ")],
            packages: Vec::new(),
        })
        .expect("compile diagnostics are a protocol result");

    let diagnostic = result.diagnostics.first().expect("at least one diagnostic");
    assert_eq!(diagnostic.line, Some(1));
    assert_eq!(diagnostic.column, Some(18));
}

#[test]
fn rejects_image_outside_virtual_root() {
    let mut session = Session::new();
    let result = session
        .compile(CompileRequest {
            clock: CLOCK,
            entry: "image.typ".into(),
            revision: 4,
            files: vec![fixture("escape/vault", "image.typ")],
            packages: Vec::new(),
        })
        .expect("missing external image is a compile result");

    assert!(result.pdf_base64.is_empty());
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == "error")
    );
}

#[test]
fn reports_an_uninstalled_package_as_never_downloaded() {
    let mut session = Session::new();
    let result = session
        .compile(CompileRequest {
            clock: CLOCK,
            entry: "package.typ".into(),
            revision: 5,
            files: vec![fixture("escape/vault", "package.typ")],
            packages: Vec::new(),
        })
        .expect("missing package is a compile result");

    assert!(result.pdf_base64.is_empty());
    let messages = error_messages(&result);
    assert!(
        messages.iter().any(|message| {
            message.contains("@preview/definitely-not-installed:0.1.0")
                && message.contains("never downloads")
        }),
        "a missing package must name itself and say nothing was downloaded, got {messages:?}"
    );
}

#[test]
fn resolves_a_package_import_from_locally_installed_files() {
    let mut session = Session::new();
    let result = session
        .compile(CompileRequest {
            clock: CLOCK,
            entry: "main.typ".into(),
            revision: 21,
            files: vec![fixture("packages/project", "main.typ")],
            packages: vec![
                package_fixture("preview/greet/0.1.0/typst.toml"),
                package_fixture("preview/greet/0.1.0/lib.typ"),
            ],
        })
        .expect("fixture compiles");

    assert_eq!(error_messages(&result), Vec::<&str>::new());
    assert!(!result.pdf_base64.is_empty());
    // Package files live outside the vault, so they must not reach the
    // dependency index that watches vault files for recompiles.
    assert_eq!(result.dependencies, vec!["main.typ".to_string()]);
}

#[test]
fn click_uses_retained_snapshot_after_source_input_changes() {
    let main = fixture("project", "main.typ");
    let asset = fixture("project", "assets/mark.svg");
    let section_bytes = std::fs::read("../tests/fixtures/project/section.typ").unwrap();
    let expected = std::str::from_utf8(&section_bytes)
        .unwrap()
        .find('한')
        .unwrap();
    let mut mutable_input = file_input("section.typ", &section_bytes);
    let mut session = Session::new();
    session
        .compile(CompileRequest {
            clock: CLOCK,
            entry: "main.typ".into(),
            revision: 17,
            files: vec![main, mutable_input.clone(), asset],
            packages: Vec::new(),
        })
        .expect("fixture compiles");
    let position = first_position(&session, 17, "section.typ", expected)
        .expect("imported glyph should have a rendered position");
    let before = click_at(&session, 17, position.clone());

    mutable_input.contents_base64 = base64::engine::general_purpose::STANDARD.encode("#invalid(");

    assert_eq!(click_at(&session, 17, position), before);
    assert!(matches!(
        before,
        ClickResponse::Source { path, .. } if path == "section.typ"
    ));
}

/// The completion fixture compiled once, plus its source text so a test can
/// name a cursor by what precedes it rather than by a hand-counted offset.
fn completion_session(revision: u64) -> (Session, String) {
    let bytes = std::fs::read("../tests/fixtures/completion/main.typ").unwrap();
    let text = String::from_utf8(bytes.clone()).unwrap();
    let mut session = Session::new();
    let compiled = session
        .compile(CompileRequest {
            clock: CLOCK,
            entry: "main.typ".into(),
            revision,
            files: vec![file_input("main.typ", &bytes)],
            packages: Vec::new(),
        })
        .expect("fixture compiles");
    assert_eq!(error_messages(&compiled), Vec::<&str>::new());
    (session, text)
}

/// Completes against a buffer the compiler has never seen. `source_text` is
/// what the editor holds now; the session only ever saw the fixture.
fn complete_in(
    session: &Session,
    revision: u64,
    source_text: &str,
    byte_offset: usize,
) -> CompleteResponse {
    session.complete(CompleteRequest {
        revision,
        source: "main.typ".into(),
        source_text: source_text.into(),
        byte_offset,
        explicit: true,
    })
}

fn complete_at(session: &Session, revision: u64, byte_offset: usize) -> CompleteResponse {
    let text = std::fs::read_to_string("../tests/fixtures/completion/main.typ").unwrap();
    complete_in(session, revision, &text, byte_offset)
}

fn completions(response: &CompleteResponse) -> &[CompletionItem] {
    match response {
        CompleteResponse::Completions { completions, .. } => completions,
        other => panic!("expected completions, got {other:?}"),
    }
}

fn definition_session(revision: u64) -> (Session, String) {
    let text = std::fs::read_to_string("../tests/fixtures/definition/main.typ").unwrap();
    let mut session = Session::new();
    let compiled = session
        .compile(CompileRequest {
            clock: CLOCK,
            entry: "main.typ".into(),
            revision,
            files: vec![
                fixture("definition", "main.typ"),
                fixture("definition", "defs.typ"),
            ],
            packages: Vec::new(),
        })
        .expect("definition fixture compiles");
    assert_eq!(error_messages(&compiled), Vec::<&str>::new());
    (session, text)
}

fn definition_in(
    session: &Session,
    revision: u64,
    source_text: &str,
    byte_offset: usize,
) -> DefinitionResponse {
    session.definition(DefinitionRequest {
        revision,
        source: "main.typ".into(),
        source_text: source_text.into(),
        byte_offset,
    })
}


fn tooltip_session(source: &str, revision: u64) -> Session {
    let mut session = Session::new();
    let compiled = session
        .compile(CompileRequest {
            clock: CLOCK,
            entry: "main.typ".into(),
            revision,
            files: vec![file_input("main.typ", source.as_bytes())],
            packages: Vec::new(),
        })
        .expect("tooltip fixture compiles");
    assert_eq!(error_messages(&compiled), Vec::<&str>::new());
    session
}

fn tooltip_in(
    session: &Session,
    revision: u64,
    source_text: &str,
    byte_offset: usize,
    side: i8,
) -> TooltipResponse {
    session.tooltip(TooltipRequest {
        revision,
        source: "main.typ".into(),
        source_text: source_text.into(),
        byte_offset,
        side,
    })
}

#[test]
fn preserves_prose_and_code_tooltips_from_the_retained_document() {
    let source = "#let x = 1 + 2\n#x\n#figure(caption: [Hi])[]<f>\n@f";
    let session = tooltip_session(source, 41);
    let code_cursor = source.find("\n#x").unwrap() + 3;
    let text_cursor = source.len();

    assert_eq!(
        tooltip_in(&session, 41, source, code_cursor, -1),
        TooltipResponse::Code {
            revision: 41,
            content: "3".into(),
        }
    );
    assert_eq!(
        tooltip_in(&session, 41, source, text_cursor, -1),
        TooltipResponse::Text {
            revision: 41,
            content: "Hi".into(),
        }
    );
}

#[test]
fn selects_the_token_after_the_tooltip_cursor() {
    let source = "#let x = 1 + 2\n#x";
    let session = tooltip_session(source, 42);
    let cursor = source.rfind('x').unwrap();

    assert_eq!(
        tooltip_in(&session, 42, source, cursor, 1),
        TooltipResponse::Code {
            revision: 42,
            content: "3".into(),
        }
    );
}

#[test]
fn offers_no_tooltip_when_the_hovered_token_changed_since_the_compile() {
    let source = "#let old = 1\n#old";
    let session = tooltip_session(source, 43);
    let live = "#let old = 1\n#other";

    assert_eq!(
        tooltip_in(&session, 43, live, live.len(), -1),
        TooltipResponse::NoTooltip { revision: 43 }
    );
}

#[test]
fn maps_an_after_side_tooltip_past_an_edit_before_the_hovered_token() {
    let source = "#let x = 1\n#x";
    let session = tooltip_session(source, 44);
    let live = "#let x = 1\n#/* note */x";
    let cursor = live.len() - 1;

    assert_eq!(
        tooltip_in(&session, 44, live, cursor, 1),
        TooltipResponse::Code {
            revision: 44,
            content: "1".into(),
        }
    );
}

#[test]
fn offers_no_tooltip_when_the_live_buffer_diverged_away_from_the_cursor() {
    let source = "#let x = 1 + 2\n#x";
    let session = tooltip_session(source, 44);
    let live = format!("X{source}");

    assert_eq!(
        tooltip_in(&session, 44, &live, live.len(), -1),
        TooltipResponse::NoTooltip { revision: 44 }
    );
}

#[test]
fn rejects_a_tooltip_without_a_retained_document() {
    assert_eq!(
        tooltip_in(&Session::new(), 45, "#x", 2, -1),
        TooltipResponse::InvalidRequest { revision: 45 }
    );
}

#[test]
fn rejects_a_stale_tooltip_revision_without_recompiling() {
    let source = "#let x = 1\n#x";
    let session = tooltip_session(source, 46);

    assert_eq!(
        tooltip_in(&session, 45, source, source.len(), -1),
        TooltipResponse::StaleRevision { expected: 46 }
    );
}

#[test]
fn rejects_an_invalid_tooltip_side() {
    let source = "#let x = 1\n#x";
    let session = tooltip_session(source, 47);

    assert_eq!(
        tooltip_in(&session, 47, source, source.len(), 0),
        TooltipResponse::InvalidRequest { revision: 47 }
    );
}

#[test]
fn rejects_an_oversized_tooltip_source() {
    let source = "#let x = 1\n#x";
    let session = tooltip_session(source, 48);
    let oversized = "x".repeat(2 * 1024 * 1024 + 1);

    assert_eq!(
        tooltip_in(&session, 48, &oversized, 0, 1),
        TooltipResponse::InvalidRequest { revision: 48 }
    );
}

#[test]
fn rejects_a_tooltip_cursor_outside_a_utf8_boundary() {
    let source = "#let x = 1\n#x";
    let session = tooltip_session(source, 49);
    let live = format!("한{source}");

    assert_eq!(
        tooltip_in(&session, 49, &live, 1, 1),
        TooltipResponse::InvalidRequest { revision: 49 }
    );
}

#[test]
fn drops_tooltip_content_above_the_response_limit() {
    let caption = "x".repeat(64 * 1024 + 1);
    let source = format!("#figure(caption: [{caption}])[]<f>\n@f");
    let session = tooltip_session(&source, 50);

    assert_eq!(
        tooltip_in(&session, 50, &source, source.len(), -1),
        TooltipResponse::NoTooltip { revision: 50 }
    );
}

#[test]
fn finds_a_local_variable_definition_in_the_retained_source() {
    let (session, text) = definition_session(20);
    let cursor = text.rfind("local").unwrap() + 2;

    assert_eq!(
        session.definition(DefinitionRequest {
            revision: 20,
            source: "main.typ".into(),
            source_text: text.clone(),
            byte_offset: cursor,
        }),
        DefinitionResponse::Source {
            revision: 20,
            path: "main.typ".into(),
            byte_offset: text.find("local =").unwrap(),
        }
    );
}

#[test]
fn finds_an_imported_symbol_definition_in_its_source() {
    let (session, text) = definition_session(21);
    let cursor = text.rfind("imported").unwrap() + 2;
    let defs = std::fs::read_to_string("../tests/fixtures/definition/defs.typ").unwrap();

    assert_eq!(
        definition_in(&session, 21, &text, cursor),
        DefinitionResponse::Source {
            revision: 21,
            path: "defs.typ".into(),
            byte_offset: defs.find("imported =").unwrap(),
        }
    );
}

#[test]
fn opens_an_imported_file_at_its_start() {
    let (session, text) = definition_session(22);
    let cursor = text.find("defs.typ").unwrap() + 2;

    assert_eq!(
        definition_in(&session, 22, &text, cursor),
        DefinitionResponse::Source {
            revision: 22,
            path: "defs.typ".into(),
            byte_offset: 0,
        }
    );
}

#[test]
fn finds_a_label_definition_from_the_retained_document() {
    let (session, text) = definition_session(23);
    let cursor = text.find("@target").unwrap() + 3;

    assert_eq!(
        definition_in(&session, 23, &text, cursor),
        DefinitionResponse::Source {
            revision: 23,
            path: "main.typ".into(),
            byte_offset: text.find("heading[Target]").unwrap(),
        }
    );
}


#[test]
fn maps_same_file_definition_after_the_cursor_when_source_is_identical() {
    let (session, text) = definition_session(31);
    let cursor = text.find("@later").unwrap() + 3;

    assert_eq!(
        definition_in(&session, 31, &text, cursor),
        DefinitionResponse::Source {
            revision: 31,
            path: "main.typ".into(),
            byte_offset: 173,
        }
    );
}

#[test]
fn offers_no_source_for_a_standard_library_definition() {
    let (session, text) = definition_session(24);
    let cursor = text.find("#text").unwrap() + 3;

    assert_eq!(
        definition_in(&session, 24, &text, cursor),
        DefinitionResponse::NoDefinition { revision: 24 }
    );
}

#[test]
fn maps_a_definition_cursor_through_text_typed_since_the_compile() {
    let (session, text) = definition_session(25);
    let usage = text.find("local + imported").unwrap();
    let mut live = text.clone();
    live.insert(usage + "local".len(), 'x');

    assert_eq!(
        definition_in(&session, 25, &live, usage + "localx".len()),
        DefinitionResponse::Source {
            revision: 25,
            path: "main.typ".into(),
            byte_offset: text.find("local =").unwrap(),
        }
    );
}

#[test]
fn drops_a_same_source_target_after_the_live_splice() {
    let (session, text) = definition_session(26);
    let reference_end = text.find("@later").unwrap() + "@later".len();
    let mut live = text.clone();
    live.insert(reference_end, 'x');

    assert_eq!(
        definition_in(&session, 26, &live, reference_end + 1),
        DefinitionResponse::NoDefinition { revision: 26 }
    );
}

#[test]
fn offers_no_definition_when_the_live_buffer_diverged_away_from_the_cursor() {
    let (session, text) = definition_session(27);
    let usage = text.find("local + imported").unwrap();
    let mut live = text.clone();
    live.insert(0, 'X');

    assert_eq!(
        definition_in(&session, 27, &live, usage + 1 + "local".len()),
        DefinitionResponse::NoDefinition { revision: 27 }
    );
}

#[test]
fn offers_no_definition_where_there_is_no_source_target() {
    let (session, text) = definition_session(28);
    let cursor = text.find("Standard]").unwrap() + "Standard".len();

    assert_eq!(
        definition_in(&session, 28, &text, cursor),
        DefinitionResponse::NoDefinition { revision: 28 }
    );
}

#[test]
fn rejects_a_stale_definition_revision_without_recompiling() {
    let (session, text) = definition_session(29);
    let cursor = text.rfind("local").unwrap() + 2;

    assert_eq!(
        definition_in(&session, 28, &text, cursor),
        DefinitionResponse::StaleRevision { expected: 29 }
    );
}

#[test]
fn bounds_definition_source_paths_text_and_cursor_offsets() {
    let (session, text) = definition_session(30);

    assert_eq!(
        session.definition(DefinitionRequest {
            revision: 30,
            source: "../outside.typ".into(),
            source_text: text.clone(),
            byte_offset: 0,
        }),
        DefinitionResponse::InvalidRequest { revision: 30 }
    );
    assert_eq!(
        definition_in(&session, 30, &text, text.len() + 1),
        DefinitionResponse::InvalidRequest { revision: 30 }
    );
    let unicode = format!("한{text}");
    assert_eq!(
        definition_in(&session, 30, &unicode, 1),
        DefinitionResponse::InvalidRequest { revision: 30 }
    );
    let oversized = "x".repeat(2 * 1024 * 1024 + 1);
    assert_eq!(
        definition_in(&session, 30, &oversized, 0),
        DefinitionResponse::InvalidRequest { revision: 30 }
    );
}

#[test]
fn completes_library_functions_after_a_markup_hash() {
    let (session, text) = completion_session(5);
    // Just after the `#` of `#lorem(3)`: markup switches to code mode there, so
    // the whole global scope is offered.
    let cursor = text.find("#lorem").unwrap() + 1;

    let response = complete_at(&session, 5, cursor);

    let items = completions(&response);
    let image = items
        .iter()
        .find(|item| item.label == "image")
        .expect("global functions should be offered after a markup hash");
    assert_eq!(image.kind, "func");
    assert!(matches!(
        response,
        CompleteResponse::Completions { revision: 5, byte_offset, .. } if byte_offset == cursor
    ));
}

#[test]
fn completes_labels_from_the_retained_document() {
    let (session, text) = completion_session(6);
    // Just after the `@` of `See @intro.`. Label completions come from the
    // compiled document, not the syntax tree, so this fails if the retained
    // document is not handed to the compiler's IDE layer.
    let cursor = text.find("@intro").unwrap() + 1;

    let response = complete_at(&session, 6, cursor);

    let items = completions(&response);
    let label = items
        .iter()
        .find(|item| item.label == "intro")
        .expect("labels of the retained document should be offered after `@`");
    assert_eq!(label.kind, "label");
}

#[test]
fn rejects_a_stale_complete_revision_without_recompiling() {
    let (session, text) = completion_session(7);
    let cursor = text.find("#lorem").unwrap() + 1;

    assert_eq!(
        complete_at(&session, 6, cursor),
        CompleteResponse::StaleRevision { expected: 7 }
    );
}

#[test]
fn rejects_a_cursor_that_is_not_a_source_boundary() {
    let (session, text) = completion_session(8);

    assert_eq!(
        complete_at(&session, 8, text.len() + 1),
        CompleteResponse::InvalidRequest { revision: 8 }
    );
    assert!(matches!(
        session.complete(CompleteRequest {
            revision: 8,
            source: "../outside.typ".into(),
            source_text: text.clone(),
            byte_offset: 0,
            explicit: true,
        }),
        CompleteResponse::InvalidRequest { revision: 8 }
    ));
    // A cursor that splits a Korean syllable of the live buffer is not a
    // position at all.
    assert_eq!(
        complete_in(&session, 8, &text, text.find("한글").unwrap() + 1),
        CompleteResponse::InvalidRequest { revision: 8 }
    );
}

#[test]
fn maps_a_cursor_typed_since_the_compile_onto_the_retained_snapshot() {
    let (session, text) = completion_session(10);
    // The user typed `im` just after the `#` of `#lorem` and no compile has run
    // since. The snapshot has no such text, so the raw live cursor would land
    // two bytes into `lorem` and describe the wrong syntax node. The heading
    // above holds Korean, so every offset here is past multi-byte text.
    let hash = text.find("#lorem").unwrap();
    let mut live = text.clone();
    live.insert_str(hash + 1, "im");

    let response = complete_in(&session, 10, &live, hash + 3);

    let items = completions(&response);
    assert!(items.iter().any(|item| item.label == "image"));
    // The reply comes back in the live buffer's own coordinates: the word to
    // replace starts right after the hash, not two bytes earlier.
    assert!(matches!(
        response,
        CompleteResponse::Completions { revision: 10, byte_offset, .. }
            if byte_offset == hash + 1
    ));
}

#[test]
fn reports_no_completions_when_the_buffer_changed_away_from_the_cursor() {
    let (session, text) = completion_session(11);
    let hash = text.find("#lorem").unwrap();

    // An edit in the heading, far from the cursor: the cursor no longer names
    // the same point in both texts, so there is nothing honest to offer.
    let mut elsewhere = text.clone();
    elsewhere.insert_str(0, "// note\n");
    assert_eq!(
        complete_in(&session, 11, &elsewhere, hash + 8 + 1),
        CompleteResponse::NoCompletions { revision: 11 }
    );

    // Two separate splices, neither of which the cursor can bridge.
    let mut scattered = text.clone();
    scattered.insert_str(hash + 1, "im");
    scattered.insert(0, 'x');
    assert_eq!(
        complete_in(&session, 11, &scattered, hash + 4),
        CompleteResponse::NoCompletions { revision: 11 }
    );
}

#[test]
fn maps_a_multibyte_insertion_back_through_the_live_buffer() {
    let (session, text) = completion_session(12);
    // The typed text is itself multi-byte, so a byte/character mix-up in the
    // splice arithmetic moves the reply.
    let at = text.find("@intro").unwrap();
    let mut live = text.clone();
    live.insert(at + 1, '한');

    let response = complete_in(&session, 12, &live, at + 1 + "한".len());

    let items = completions(&response);
    assert!(items.iter().any(|item| item.label == "intro"));
    assert!(matches!(
        response,
        CompleteResponse::Completions { revision: 12, byte_offset, .. }
            if byte_offset == at + 1
    ));
}

#[test]
fn refuses_a_live_buffer_larger_than_the_completion_limit() {
    let (session, text) = completion_session(13);
    let oversized = "x".repeat(2 * 1024 * 1024 + 1);

    assert_eq!(
        complete_in(&session, 13, &oversized, 0),
        CompleteResponse::InvalidRequest { revision: 13 }
    );
    // The bound is on the request, not on what the session retained.
    assert!(matches!(
        complete_at(&session, 13, text.find("#lorem").unwrap() + 1),
        CompleteResponse::Completions { .. }
    ));
}

#[test]
fn reports_no_completions_inside_plain_markup_text() {
    let (session, text) = completion_session(9);
    // Inside the word `Intro` of the heading: implicit completion in running
    // text must stay silent rather than dumping the global scope.
    let cursor = text.find("Intro").unwrap() + 2;

    assert_eq!(
        session.complete(CompleteRequest {
            revision: 9,
            source: "main.typ".into(),
            source_text: text.clone(),
            byte_offset: cursor,
            explicit: false,
        }),
        CompleteResponse::NoCompletions { revision: 9 }
    );
}

#[test]
fn resolves_the_current_date_from_the_host_clock() {
    let source = "#assert.eq(datetime.today().display(\"[year]-[month]-[day]\"), \"2026-08-27\")\n\
                  #assert.eq(datetime.today(offset: 0).display(\"[year]-[month]-[day]\"), \"2026-08-26\")\n\
                  Dated";
    let compiled = Session::new()
        .compile(CompileRequest {
            clock: CLOCK,
            entry: "main.typ".into(),
            revision: 1,
            files: vec![file_input("main.typ", source.as_bytes())],
            packages: Vec::new(),
        })
        .expect("compile succeeds");

    assert_eq!(
        compiled
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.severity == "error")
            .map(|diagnostic| diagnostic.message.as_str())
            .collect::<Vec<_>>(),
        Vec::<&str>::new()
    );
    assert!(compiled.pdf_bytes > 0);
}

#[test]
fn rejects_documents_over_the_supported_page_count() {
    let source = "#set page(width: 10pt, height: 10pt, margin: 0pt)\n\
                  #for _ in range(1001) { pagebreak(weak: false) }";
    let result = compile_source(source);

    match result {
        Err(error) => assert_eq!(error, "document exceeds 1000 page limit"),
        Ok(_) => panic!("document over the supported page count compiled"),
    }
}

#[test]
fn rejects_documents_over_the_supported_page_size() {
    let source = "#set page(width: 14401pt, height: 10pt, margin: 0pt)\nOversized";
    let result = compile_source(source);

    match result {
        Err(error) => assert_eq!(error, "document page exceeds 14400 point edge limit"),
        Ok(_) => panic!("document over the supported page size compiled"),
    }
}

#[test]
fn compiles_documents_at_the_supported_page_count() {
    let source = "#set page(width: 10pt, height: 10pt, margin: 0pt)\n\
                  #for _ in range(999) { pagebreak(weak: false) }";
    let compiled = compile_source(source).expect("document at the supported page count compiles");

    assert_eq!(compiled.pages.len(), 1000);
}

#[test]
fn compiles_documents_at_the_supported_page_size() {
    let source = "#set page(width: 14400pt, height: 10pt, margin: 0pt)\nSupported";
    let compiled = compile_source(source).expect("document at the supported page size compiles");

    assert_eq!(compiled.pages[0].width_pt, 14_400.0);
}

#[test]
fn rejects_documents_over_the_supported_page_height() {
    let source = "#set page(width: 10pt, height: 14401pt, margin: 0pt)\nOversized";
    let result = compile_source(source);

    match result {
        Err(error) => assert_eq!(error, "document page exceeds 14400 point edge limit"),
        Ok(_) => panic!("document over the supported page height compiled"),
    }
}

#[test]
fn default_text_uses_the_bundled_libertinus_serif_faces() {
    let source = r#"
Regular
#text(style: "italic")[Italic]
#text(weight: "bold")[Bold]
#text(weight: "bold", style: "italic")[Bold italic]
#text(weight: "semibold")[Semibold]
#text(weight: "semibold", style: "italic")[Semibold italic]
"#;
    let compiled = compile_source(source).expect("default text compiles without system fonts");

    assert_eq!(error_messages(&compiled), Vec::<&str>::new());
    let pdf = base64::engine::general_purpose::STANDARD
        .decode(compiled.pdf_base64)
        .expect("compiler returns a base64-encoded PDF");
    let pdf_text = String::from_utf8_lossy(&pdf);
    for face in [
        "LibertinusSerif-Regular",
        "LibertinusSerif-Italic",
        "LibertinusSerif-Bold",
        "LibertinusSerif-BoldItalic",
        "LibertinusSerif-Semibold",
        "LibertinusSerif-SemiboldItalic",
    ] {
        assert!(pdf_text.contains(face), "PDF does not use {face}");
    }
}
