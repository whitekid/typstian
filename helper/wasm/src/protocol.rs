use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClickRequest {
    pub revision: u64,
    pub page: usize,
    pub x_pt: f64,
    pub y_pt: f64,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ForwardRequest {
    pub revision: u64,
    pub source: String,
    pub byte_offset: usize,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompleteRequest {
    pub revision: u64,
    pub source: String,
    /// The buffer the cursor belongs to, which is usually a few keystrokes
    /// ahead of the snapshot the session retained. The compiler reconciles the
    /// two rather than assuming the offset means the same thing in both.
    pub source_text: String,
    pub byte_offset: usize,
    /// Whether the user asked for completions outright. Typst offers far less
    /// on an implicit request, which is what keeps plain prose quiet.
    pub explicit: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionRequest {
    pub revision: u64,
    pub source: String,
    pub source_text: String,
    pub byte_offset: usize,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TooltipRequest {
    pub revision: u64,
    pub source: String,
    pub source_text: String,
    pub byte_offset: usize,
    /// CodeMirror reports -1 for the token before the cursor and +1 for the
    /// token after it.
    pub side: i8,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompletionItem {
    pub kind: String,
    pub label: String,
    /// The text to insert, in snippet syntax (`${name}` placeholders), when it
    /// differs from the label.
    pub apply: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RenderedPosition {
    pub page: usize,
    pub x_pt: f64,
    pub y_pt: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub file: Option<String>,
    pub line: Option<usize>,
    pub column: Option<usize>,
    pub severity: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageDimensions {
    pub width_pt: f64,
    pub height_pt: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum ClickResponse {
    Source {
        revision: u64,
        path: String,
        #[serde(rename = "byteOffset")]
        byte_offset: usize,
    },
    NoSource {
        revision: u64,
    },
    InvalidRequest {
        revision: u64,
    },
    StaleRevision {
        expected: u64,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum CompleteResponse {
    Completions {
        revision: u64,
        /// Where the completed word starts in the *requesting* buffer, so the
        /// editor replaces the prefix the user already typed instead of
        /// doubling it.
        #[serde(rename = "byteOffset")]
        byte_offset: usize,
        completions: Vec<CompletionItem>,
    },
    NoCompletions {
        revision: u64,
    },
    InvalidRequest {
        revision: u64,
    },
    StaleRevision {
        expected: u64,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum DefinitionResponse {
    Source {
        revision: u64,
        path: String,
        #[serde(rename = "byteOffset")]
        byte_offset: usize,
    },
    NoDefinition {
        revision: u64,
    },
    InvalidRequest {
        revision: u64,
    },
    StaleRevision {
        expected: u64,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum TooltipResponse {
    Text { revision: u64, content: String },
    Code { revision: u64, content: String },
    NoTooltip { revision: u64 },
    InvalidRequest { revision: u64 },
    StaleRevision { expected: u64 },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum ForwardResponse {
    Positions {
        revision: u64,
        positions: Vec<RenderedPosition>,
    },
    NoPosition {
        revision: u64,
    },
    InvalidRequest {
        revision: u64,
    },
    StaleRevision {
        expected: u64,
    },
}
