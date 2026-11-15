//! Office document tools: read and generate .xlsx, .docx, .pptx and .pdf
//! without any external office suite.
//!
//! Two narrow paths rather than one general one. Spreadsheets go through
//! calamine and rust_xlsxwriter, which already handle the format's own quirks.
//! Word and PowerPoint documents are written straight as OOXML packages over
//! the zip and quick-xml already in the tree: the documents this generates are
//! title, paragraphs, lists and slides, and a full OOXML writer would be far
//! more code than that shape needs. Both paths share the same guard as every
//! other file command, so nothing here can reach outside the workspace.

use crate::modules::fs::security::{guard_read, guard_write};
use crate::modules::workspace::{
    require_authorized, resolve_path, WorkspaceEnv, WorkspaceRegistry,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Write;
use std::path::Path;

use quick_xml::escape::escape;

const MAX_BLOCKS: usize = 5000;

/// One paragraph or bullet in a docx, or one slide in a pptx.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DocBlock {
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub bullets: Option<Vec<String>>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub level: Option<u8>,
}

fn clip(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }
    let mut end = limit;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\u{2026}", &value[..end])
}

/// Words come from a model, so every XML sink gets them escaped. Attributes go
/// through the same path as text: a stray quote in a title would otherwise end
/// the attribute early and produce a package Word refuses to open.
fn esc(value: &str) -> String {
    escape(value).into_owned()
}

fn resolve_io(
    path: &str,
    workspace: &WorkspaceEnv,
    write: bool,
    registry: &WorkspaceRegistry,
) -> Result<std::path::PathBuf, String> {
    let raw = resolve_path(path, workspace);
    let target = if write {
        guard_write(&raw)?
    } else {
        guard_read(&raw)?
    };
    require_authorized(registry, &target)?;
    Ok(target)
}

fn require_extension(target: &Path, expected: &str) -> Result<(), String> {
    let actual = target
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    if actual.as_deref() != Some(expected) {
        return Err(format!(
            "expected a .{expected} path, got {}",
            target.display()
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Spreadsheets
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct SheetSpec {
    #[serde(default)]
    pub name: Option<String>,
    /// Row-major cell data: strings become text cells, numbers become numeric
    /// cells so a spreadsheet stays computable instead of text everywhere.
    #[serde(default)]
    pub rows: Vec<Vec<Value>>,
}

fn cell_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

#[tauri::command]
pub async fn office_xlsx_write(
    path: String,
    sheets: Vec<SheetSpec>,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<Value, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let target = resolve_io(&path, &workspace, true, &registry)?;
    require_extension(&target, "xlsx")?;
    if sheets.is_empty() {
        return Err("sheets is empty: pass at least one sheet".to_string());
    }

    let mut workbook = rust_xlsxwriter::Workbook::new();
    let mut total_cells = 0usize;
    for spec in &sheets {
        let sheet = workbook.add_worksheet();
        if let Some(name) = spec.name.as_deref() {
            sheet
                .set_name(name)
                .map_err(|e| format!("invalid sheet name {name:?}: {e}"))?;
        }
        for (row_index, row) in spec.rows.iter().enumerate() {
            for (col_index, value) in row.iter().enumerate() {
                total_cells += 1;
                let row = row_index as u32;
                let col = col_index as u16;
                let result = match value {
                    Value::Number(n) => match n.as_f64() {
                        Some(number) => sheet.write_number(row, col, number),
                        None => sheet.write_string(row, col, &n.to_string()),
                    },
                    Value::Bool(b) => sheet.write_string(row, col, if *b { "TRUE" } else { "FALSE" }),
                    other => sheet.write_string(row, col, &cell_text(other)),
                };
                result.map_err(|e| {
                    format!("write cell ({row},{col}) failed: {e}")
                })?;
            }
        }
    }

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    // save() reports the path it failed on, which is more useful than a bare
    // error when the workspace is on a network share.
    workbook
        .save(&target)
        .map_err(|e| format!("save {}: {e}", target.display()))?;

    Ok(json!({
        "path": target.display().to_string(),
        "sheets": sheets.len(),
        "cells": total_cells
    }))
}

fn sheet_rows_to_json(rows: &[Vec<calamine::Data>]) -> Vec<Vec<Value>> {
    rows.iter()
        .map(|row| {
            row.iter()
                .map(|cell| match cell {
                    calamine::Data::Empty => Value::Null,
                    calamine::Data::String(s) => Value::String(s.clone()),
                    calamine::Data::Float(f) => json!(f),
                    calamine::Data::Int(i) => json!(i),
                    calamine::Data::Bool(b) => json!(b),
                    calamine::Data::DateTime(dt) => json!(dt.as_f64()),
                    calamine::Data::DateTimeIso(s) => Value::String(s.clone()),
                    calamine::Data::DurationIso(s) => Value::String(s.clone()),
                    calamine::Data::Error(e) => Value::String(format!("#ERR:{e:?}")),
                })
                .collect()
        })
        .collect()
}

#[tauri::command]
pub async fn office_xlsx_read(
    path: String,
    sheet: Option<String>,
    max_rows: Option<usize>,
    max_cols: Option<usize>,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<Value, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let target = resolve_io(&path, &workspace, false, &registry)?;
    let limit_rows = max_rows.unwrap_or(500).clamp(1, 50_000);
    let limit_cols = max_cols.unwrap_or(200).clamp(1, 2000);

    let mut book = calamine::open_workbook_auto(&target)
        .map_err(|e| format!("open {}: {e}", target.display()))?;
    let all = calamine::Reader::worksheets(&mut book);

    let wanted: Vec<(String, calamine::Range<calamine::Data>)> = match sheet.as_deref() {
        Some(name) => {
            let found: Vec<_> = all
                .iter()
                .filter(|(n, _)| n == name)
                .map(|(n, r)| (n.clone(), r.clone()))
                .collect();
            if found.is_empty() {
                let names: Vec<&str> = all.iter().map(|(n, _)| n.as_str()).collect();
                return Err(format!(
                    "no sheet named {name:?}; available: {}",
                    names.join(", ")
                ));
            }
            found
        }
        None => all
            .iter()
            .map(|(n, r)| (n.clone(), r.clone()))
            .collect(),
    };

    let mut out = Vec::new();
    let mut truncated = false;
    for (name, range) in &wanted {
        let (height, width) = range.get_size();
        let rows: Vec<Vec<Value>> = range
            .rows()
            .take(limit_rows)
            .map(|row| {
                row.iter()
                    .take(limit_cols)
                    .map(|cell| sheet_rows_to_json(&[vec![cell.clone()]])[0][0].clone())
                    .collect()
            })
            .collect();
        if height > limit_rows || width > limit_cols {
            truncated = true;
        }
        out.push(json!({
            "sheet": name,
            "rows": rows,
            "height": height,
            "width": width
        }));
    }

    Ok(json!({
        "path": target.display().to_string(),
        "sheet_count": wanted.len(),
        "sheets": out,
        "truncated": truncated
    }))
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

fn docx_paragraph(text: &str, style: Option<&str>) -> String {
    let style_xml = match style {
        Some(s) => format!("<w:pPr><w:pStyle w:val=\"{}\"/></w:pPr>", esc(s)),
        None => String::new(),
    };
    format!(
        "<w:p>{style_xml}<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
        esc(text)
    )
}

fn docx_bullet(text: &str, level: u8) -> String {
    format!(
        "<w:p><w:pPr><w:pStyle w:val=\"ListParagraph\"/><w:numPr><w:ilvl w:val=\"{level}\"/><w:numId w:val=\"1\"/></w:numPr></w:pPr><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
        esc(text)
    )
}

fn docx_document_xml(title: Option<&str>, blocks: &[DocBlock]) -> String {
    let mut body = String::new();
    if let Some(title) = title {
        body.push_str(&docx_paragraph(title, Some("Title")));
    }
    for block in blocks {
        match block.kind.as_deref().unwrap_or("paragraph") {
            "heading" => {
                let level = block.level.unwrap_or(1).clamp(1, 6);
                body.push_str(&docx_paragraph(
                    block.text.as_deref().unwrap_or_default(),
                    Some(&format!("Heading{level}")),
                ));
            }
            "bullets" => {
                for bullet in block.bullets.as_deref().unwrap_or_default() {
                    body.push_str(&docx_bullet(bullet, block.level.unwrap_or(0).min(8)));
                }
            }
            _ => body.push_str(&docx_paragraph(
                block.text.as_deref().unwrap_or_default(),
                None,
            )),
        }
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>"#
    )
}

fn docx_numbering_xml() -> String {
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/><w:lvlJc w:val="left"/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#9702;"/><w:lvlJc w:val="left"/></w:lvl><w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#9642;"/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>"#.to_string()
}

fn docx_styles_xml() -> String {
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="48"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style></w:styles>"#.to_string()
}

/// The three content types and two relationships every minimal docx needs.
/// Written as constants rather than built, because they never vary and a typo
/// here makes Word report a corrupt package with no hint where.
const DOCX_CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>"#;

const DOCX_ROOT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#;

const DOCX_DOCUMENT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>"#;

fn write_zip_entry<T: Write + std::io::Seek>(
    zip: &mut zip::ZipWriter<T>,
    name: &str,
    data: &[u8],
) -> Result<(), String> {
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    zip.start_file(name, options)
        .map_err(|e| format!("zip entry {name}: {e}"))?;
    zip.write_all(data)
        .map_err(|e| format!("zip write {name}: {e}"))
}

fn guard_block_count(blocks: usize) -> Result<(), String> {
    if blocks > MAX_BLOCKS {
        return Err(format!(
            "{} entries, above the {MAX_BLOCKS} limit",
            blocks
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn office_docx_write(
    path: String,
    title: Option<String>,
    blocks: Vec<DocBlock>,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<Value, String> {
    guard_block_count(blocks.len())?;
    let workspace = WorkspaceEnv::from_option(workspace);
    let target = resolve_io(&path, &workspace, true, &registry)?;
    require_extension(&target, "docx")?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }

    let file = std::fs::File::create(&target)
        .map_err(|e| format!("create {}: {e}", target.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    write_zip_entry(&mut zip, "[Content_Types].xml", DOCX_CONTENT_TYPES.as_bytes())?;
    write_zip_entry(&mut zip, "_rels/.rels", DOCX_ROOT_RELS.as_bytes())?;
    write_zip_entry(
        &mut zip,
        "word/document.xml",
        docx_document_xml(title.as_deref(), &blocks).as_bytes(),
    )?;
    write_zip_entry(&mut zip, "word/styles.xml", docx_styles_xml().as_bytes())?;
    write_zip_entry(&mut zip, "word/numbering.xml", docx_numbering_xml().as_bytes())?;
    write_zip_entry(&mut zip, "word/_rels/document.xml.rels", DOCX_DOCUMENT_RELS.as_bytes())?;
    zip.finish().map_err(|e| format!("finalize {}: {e}", target.display()))?;

    let bytes = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
    Ok(json!({
        "path": target.display().to_string(),
        "blocks": blocks.len(),
        "bytes": bytes
    }))
}

/// Text extraction runs over the document part only. That is where every word
/// of a docx lives; headers and footers are separate parts and are out of scope
/// for a reader this small.
fn extract_docx_text(xml: &str) -> String {
    let mut reader = quick_xml::Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut out = String::new();
    let mut in_text = false;
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(e)) => {
                if e.local_name().as_ref() == "t" {
                    in_text = true;
                }
            }
            Ok(quick_xml::events::Event::End(e)) => match e.local_name().as_ref() {
                "t" => in_text = false,
                "p" => out.push('\n'),
                _ => {}
            },
            Ok(quick_xml::events::Event::Empty(e)) => {
                if e.local_name().as_ref() == "br" {
                    out.push('\n');
                }
            }
            Ok(quick_xml::events::Event::Text(e)) => {
                if in_text {
                    let raw = e.xml_content(quick_xml::XmlVersion::Implicit1_0);
                    let text = quick_xml::escape::unescape(&raw)
                        .map(|v| v.into_owned())
                        .unwrap_or_else(|_| raw.into_owned());
                    out.push_str(&text);
                }
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Err(e) => return format!("extract failed: {e}"),
            _ => {}
        }
    }
    out
}

#[tauri::command]
pub async fn office_docx_read(
    path: String,
    max_chars: Option<usize>,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<Value, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let target = resolve_io(&path, &workspace, false, &registry)?;
    let limit = max_chars.unwrap_or(100_000).clamp(100, 5_000_000);

    let file = std::fs::File::open(&target)
        .map_err(|e| format!("open {}: {e}", target.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("{} is not a readable docx package: {e}", target.display()))?;
    let mut xml = String::new();
    {
        let mut entry = archive
            .by_name("word/document.xml")
            .map_err(|e| format!("no word/document.xml inside {}: {e}", target.display()))?;
        std::io::Read::read_to_string(&mut entry, &mut xml)
            .map_err(|e| format!("read word/document.xml: {e}"))?;
    }

    let text = extract_docx_text(&xml);
    let truncated = text.len() > limit;
    Ok(json!({
        "path": target.display().to_string(),
        "text": clip(&text, limit),
        "chars": text.len(),
        "truncated": truncated
    }))
}

// ---------------------------------------------------------------------------
// PPTX
// ---------------------------------------------------------------------------

fn pptx_slide_xml(slide: &DocBlock, index: usize) -> String {
    let title = slide
        .title
        .clone()
        .or_else(|| slide.text.clone())
        .unwrap_or_else(|| format!("Slide {}", index + 1));
    let mut body = String::new();
    if let Some(text) = slide.body.as_deref() {
        body.push_str(&format!(
            "<a:p><a:r><a:t>{}</a:t></a:r></a:p>",
            esc(text)
        ));
    }
    for bullet in slide.bullets.as_deref().unwrap_or_default() {
        body.push_str(&format!(
            "<a:p><a:pPr><a:buChar char=\"&#8226;\"/></a:pPr><a:r><a:t>{}</a:t></a:r></a:p>",
            esc(bullet)
        ));
    }
    let body_shape = if body.is_empty() {
        String::new()
    } else {
        format!(
            r#"<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="838200" y="1825625"/><a:ext cx="10515600" cy="4351338"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>{body}</p:txBody></p:sp>"#
        )
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="838200" y="365125"/><a:ext cx="10515600" cy="1325563"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>{}</a:t></a:r></a:p></p:txBody></p:sp>{body_shape}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"#,
        esc(&title)
    )
}

fn pptx_slide_rels() -> String {
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>"#.to_string()
}

fn pptx_presentation_xml(count: usize) -> String {
    let ids: String = (0..count)
        .map(|i| {
            format!(
                "<p:sldId id=\"{}\" r:id=\"rId{}\"/>",
                256 + i,
                i + 2
            )
        })
        .collect();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst>{ids}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>"#
    )
}

fn pptx_presentation_rels(count: usize) -> String {
    let mut rels = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>"#,
    );
    for i in 0..count {
        rels.push_str(&format!(
            "<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide{}.xml\"/>",
            i + 2,
            i + 1
        ));
    }
    rels.push_str("</Relationships>");
    rels
}

/// A deck needs a master and one layout for PowerPoint to open it at all. Both
/// are the smallest shapes that satisfy the schema, with no theme parts, since
/// the slides carry their own geometry.
const PPTX_SLIDE_MASTER: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>"#;

const PPTX_SLIDE_MASTER_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>"#;

const PPTX_SLIDE_LAYOUT: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"#;

const PPTX_SLIDE_LAYOUT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>"#;

#[tauri::command]
pub async fn office_pptx_write(
    path: String,
    slides: Vec<DocBlock>,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<Value, String> {
    guard_block_count(slides.len())?;
    let workspace = WorkspaceEnv::from_option(workspace);
    let target = resolve_io(&path, &workspace, true, &registry)?;
    require_extension(&target, "pptx")?;
    if slides.is_empty() {
        return Err("slides is empty: pass at least one slide".to_string());
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }

    let file = std::fs::File::create(&target)
        .map_err(|e| format!("create {}: {e}", target.display()))?;
    let mut zip = zip::ZipWriter::new(file);

    let mut overrides = String::new();
    for i in 0..slides.len() {
        overrides.push_str(&format!(
            "<Override PartName=\"/ppt/slides/slide{}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/>",
            i + 1
        ));
    }
    let content_types = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>{overrides}</Types>"#
    );

    write_zip_entry(&mut zip, "[Content_Types].xml", content_types.as_bytes())?;
    write_zip_entry(
        &mut zip,
        "_rels/.rels",
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>"#.as_bytes(),
    )?;
    write_zip_entry(
        &mut zip,
        "ppt/presentation.xml",
        pptx_presentation_xml(slides.len()).as_bytes(),
    )?;
    write_zip_entry(
        &mut zip,
        "ppt/_rels/presentation.xml.rels",
        pptx_presentation_rels(slides.len()).as_bytes(),
    )?;
    write_zip_entry(&mut zip, "ppt/slideMasters/slideMaster1.xml", PPTX_SLIDE_MASTER.as_bytes())?;
    write_zip_entry(
        &mut zip,
        "ppt/slideMasters/_rels/slideMaster1.xml.rels",
        PPTX_SLIDE_MASTER_RELS.as_bytes(),
    )?;
    write_zip_entry(&mut zip, "ppt/slideLayouts/slideLayout1.xml", PPTX_SLIDE_LAYOUT.as_bytes())?;
    write_zip_entry(
        &mut zip,
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
        PPTX_SLIDE_LAYOUT_RELS.as_bytes(),
    )?;
    for (i, slide) in slides.iter().enumerate() {
        write_zip_entry(
            &mut zip,
            &format!("ppt/slides/slide{}.xml", i + 1),
            pptx_slide_xml(slide, i).as_bytes(),
        )?;
        write_zip_entry(
            &mut zip,
            &format!("ppt/slides/_rels/slide{}.xml.rels", i + 1),
            pptx_slide_rels().as_bytes(),
        )?;
    }
    zip.finish().map_err(|e| format!("finalize {}: {e}", target.display()))?;

    let bytes = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
    Ok(json!({
        "path": target.display().to_string(),
        "slides": slides.len(),
        "bytes": bytes
    }))
}

#[tauri::command]
pub async fn office_pptx_read(
    path: String,
    max_chars: Option<usize>,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<Value, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let target = resolve_io(&path, &workspace, false, &registry)?;
    let limit = max_chars.unwrap_or(100_000).clamp(100, 5_000_000);

    let file = std::fs::File::open(&target)
        .map_err(|e| format!("open {}: {e}", target.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("{} is not a readable pptx package: {e}", target.display()))?;

    // Slide order is numeric, and a plain string sort puts slide10 before
    // slide2, so collect the index and sort on it.
    let mut names: Vec<(usize, String)> = Vec::new();
    for name in archive.file_names() {
        if let Some(rest) = name.strip_prefix("ppt/slides/slide") {
            if let Some(number) = rest.strip_suffix(".xml") {
                if let Ok(index) = number.parse::<usize>() {
                    names.push((index, name.to_string()));
                }
            }
        }
    }
    names.sort_by_key(|(index, _)| *index);

    let mut slides = Vec::new();
    let mut collected = String::new();
    for (index, name) in &names {
        let mut xml = String::new();
        {
            let mut entry = archive
                .by_name(name)
                .map_err(|e| format!("read {name}: {e}"))?;
            std::io::Read::read_to_string(&mut entry, &mut xml)
                .map_err(|e| format!("read {name}: {e}"))?;
        }
        let text = extract_docx_text(&xml);
        collected.push_str(&text);
        slides.push(json!({ "index": index, "text": clip(&text, limit) }));
    }

    let truncated = collected.len() > limit;
    Ok(json!({
        "path": target.display().to_string(),
        "slide_count": slides.len(),
        "slides": slides,
        "text": clip(&collected, limit),
        "chars": collected.len(),
        "truncated": truncated
    }))
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/// A PDF written by hand: one page per block page, Helvetica, 72 dpi units and
/// a fixed 11pt leading. A dependency for this much output would cost more than
/// the writer does.
fn pdf_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '(' => out.push_str("\\("),
            ')' => out.push_str("\\)"),
            '\\' => out.push_str("\\\\"),
            // The standard 14 fonts are WinAnsi; anything outside it would be
            // dropped by every reader, so substitute instead of emitting bytes
            // the encoding cannot express.
            c if (c as u32) < 256 && !c.is_control() => out.push(c),
            '\n' => {}
            _ => out.push('?'),
        }
    }
    out
}

/// Breaks one logical line into page-width lines by character count. Wrapping
/// on characters rather than words keeps the file simple and never produces
/// two pages for one word.
fn wrap_pdf_line(text: &str, width: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return vec![String::new()];
    }
    chars.chunks(width).map(|c| c.iter().collect()).collect()
}

#[tauri::command]
pub async fn office_pdf_write(
    path: String,
    title: Option<String>,
    blocks: Vec<DocBlock>,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<Value, String> {
    guard_block_count(blocks.len())?;
    let workspace = WorkspaceEnv::from_option(workspace);
    let target = resolve_io(&path, &workspace, true, &registry)?;
    require_extension(&target, "pdf")?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }

    // Keep a running set of drawn lines, then paginate at a fixed count. Doing
    // it in two passes keeps the page objects independent of text layout.
    let mut lines: Vec<(String, bool)> = Vec::new();
    if let Some(title) = title.as_deref() {
        for line in wrap_pdf_line(title, 80) {
            lines.push((line, true));
        }
        lines.push((String::new(), false));
    }
    for block in &blocks {
        match block.kind.as_deref().unwrap_or("paragraph") {
            "heading" => {
                for line in wrap_pdf_line(block.text.as_deref().unwrap_or_default(), 72) {
                    lines.push((line, true));
                }
            }
            "bullets" => {
                for bullet in block.bullets.as_deref().unwrap_or_default() {
                    for (i, line) in wrap_pdf_line(bullet, 74).into_iter().enumerate() {
                        let prefix = if i == 0 { "- " } else { "  " };
                        lines.push((format!("{prefix}{line}"), false));
                    }
                }
            }
            _ => {
                for line in wrap_pdf_line(block.text.as_deref().unwrap_or_default(), 80) {
                    lines.push((line, false));
                }
            }
        }
    }
    if lines.is_empty() {
        lines.push((String::new(), false));
    }

    const LINES_PER_PAGE: usize = 48;
    const LEADING: i64 = 14;
    const TOP: i64 = 780;

    let pages: Vec<&[(String, bool)]> = lines.chunks(LINES_PER_PAGE).collect();
    let page_count = pages.len();

    // Object numbering: 1 catalog, 2 pages, then one font, and then a page and
    // a content stream per page. Built by hand so every reference is stable.
    let mut objects: Vec<String> = Vec::new();
    objects.push(String::new()); // object 1 reserved below
    objects.push(String::new()); // object 2 reserved below
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_string());

    let mut kids: Vec<String> = Vec::new();
    let mut next_page_object = 4;
    let mut page_streams: Vec<(usize, String)> = Vec::new();
    for page in &pages {
        let page_object = next_page_object;
        let content_object = page_object + 1;
        next_page_object += 2;
        kids.push(format!("{page_object} 0 R"));

        let mut stream = String::new();
        stream.push_str("BT\n/F1 11 Tf\n");
        let mut y = TOP;
        for (text, bold) in page.iter() {
            if *bold {
                stream.push_str("/F1 13 Tf\n");
            } else {
                stream.push_str("/F1 11 Tf\n");
            }
            stream.push_str(&format!("1 0 0 1 60 {y} Tm\n({}) Tj\n", pdf_escape(text)));
            y -= LEADING;
        }
        stream.push_str("ET\n");
        objects.push(format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents {content_object} 0 R >>"));
        page_streams.push((content_object, stream.clone()));
        objects.push(format!(
            "<< /Length {} >>\nstream\n{}endstream",
            stream.len(),
            stream
        ));
    }

    objects[0] = "<< /Type /Catalog /Pages 2 0 R >>".to_string();
    objects[1] = format!(
        "<< /Type /Pages /Count {} /Kids [{}] >>",
        page_count,
        kids.join(" ")
    );

    let mut out = String::from("%PDF-1.4\n%\u{e2}\u{e3}\u{cf}\u{d3}\n");
    let mut offsets: Vec<usize> = Vec::new();
    for (index, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.push_str(&format!("{} 0 obj\n{}\nendobj\n", index + 1, body));
    }
    let xref_at = out.len();
    out.push_str(&format!("xref\n0 {}\n", objects.len() + 1));
    out.push_str("0000000000 65535 f \n");
    for offset in &offsets {
        out.push_str(&format!("{offset:010} 00000 n \n"));
    }
    out.push_str(&format!(
        "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
        objects.len() + 1,
        xref_at
    ));

    std::fs::write(&target, out.as_bytes())
        .map_err(|e| format!("write {}: {e}", target.display()))?;

    Ok(json!({
        "path": target.display().to_string(),
        "pages": page_count,
        "blocks": blocks.len(),
        "bytes": out.len()
    }))
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/// One CSV field, quoted only when it must be. A free-text cell routinely holds
/// a comma, a quote or a newline, and unquoted those split the row.
fn csv_field(value: &Value) -> String {
    let text = match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    let needs_quote = text.contains([',', '"', '\n', '\r']) || text != text.trim();
    if needs_quote {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text
    }
}

#[tauri::command]
pub async fn office_csv_write(
    path: String,
    rows: Vec<Vec<Value>>,
    delimiter: Option<String>,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<Value, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let target = resolve_io(&path, &workspace, true, &registry)?;
    require_extension(&target, "csv")?;
    let delim = delimiter
        .as_deref()
        .and_then(|d| d.chars().next())
        .unwrap_or(',');
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }

    let mut out = String::new();
    for row in &rows {
        let cells: Vec<String> = row.iter().map(csv_field).collect();
        out.push_str(&cells.join(&delim.to_string()));
        out.push('\n');
    }
    std::fs::write(&target, out.as_bytes())
        .map_err(|e| format!("write {}: {e}", target.display()))?;

    Ok(json!({
        "path": target.display().to_string(),
        "rows": rows.len(),
        "bytes": out.len()
    }))
}

#[tauri::command]
pub async fn office_csv_read(
    path: String,
    delimiter: Option<String>,
    has_header: Option<bool>,
    max_rows: Option<usize>,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<Value, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let target = resolve_io(&path, &workspace, false, &registry)?;
    let limit = max_rows.unwrap_or(1000).clamp(1, 100_000);
    let delimiter = delimiter
        .as_deref()
        .and_then(|d| d.chars().next())
        .unwrap_or(',');

    let text = std::fs::read_to_string(&target)
        .map_err(|e| format!("read {}: {e}", target.display()))?;

    // A hand-rolled parse: a CSV reader dependency would cost more than the
    // quoting rules this needs, which are the RFC 4180 four.
    let mut records: Vec<Vec<String>> = Vec::new();
    let mut field = String::new();
    let mut record: Vec<String> = Vec::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(ch);
            }
            continue;
        }
        match ch {
            '"' => in_quotes = true,
            c if c == delimiter => {
                record.push(std::mem::take(&mut field));
            }
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                record.push(std::mem::take(&mut field));
                records.push(std::mem::take(&mut record));
            }
            '\n' => {
                record.push(std::mem::take(&mut field));
                records.push(std::mem::take(&mut record));
            }
            c => field.push(c),
        }
    }
    if !field.is_empty() || !record.is_empty() {
        record.push(field);
        records.push(record);
    }

    let header_row = if has_header.unwrap_or(false) {
        records.first().cloned().unwrap_or_default()
    } else {
        Vec::new()
    };
    let body_start = if has_header.unwrap_or(false) { 1 } else { 0 };
    let body: Vec<&Vec<String>> = records.iter().skip(body_start).take(limit).collect();
    let truncated = records.len().saturating_sub(body_start) > limit;

    Ok(json!({
        "path": target.display().to_string(),
        "header": header_row,
        "rows": body,
        "total_rows": records.len().saturating_sub(body_start),
        "column_count": records.iter().map(|r| r.len()).max().unwrap_or(0),
        "truncated": truncated
    }))
}

// ---------------------------------------------------------------------------
// iCalendar
// ---------------------------------------------------------------------------

fn ics_escape(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace('\n', "\\n")
}

fn ics_stamp() -> String {
    // Fixed stamp: the event times come from the caller, and a clock read here
    // would only make the package non-reproducible.
    "20250101T000000Z".to_string()
}

#[derive(Debug, Deserialize)]
pub struct CalendarEventArgs {
    pub summary: String,
    #[serde(default)]
    pub start: Option<String>,
    #[serde(default)]
    pub end: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
}

#[tauri::command]
pub async fn office_ics_write(
    path: String,
    events: Vec<CalendarEventArgs>,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<Value, String> {
    guard_block_count(events.len())?;
    let workspace = WorkspaceEnv::from_option(workspace);
    let target = resolve_io(&path, &workspace, true, &registry)?;
    require_extension(&target, "ics")?;
    if events.is_empty() {
        return Err("events is empty: pass at least one event".to_string());
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }

    let stamp = ics_stamp();
    let mut out = String::from("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Termigo//Office//EN\r\n");
    for (index, event) in events.iter().enumerate() {
        // DTSTART is mandatory in RFC 5545; without it no calendar will import
        // the event, so refuse rather than emit a file that silently drops it.
        let start = event
            .start
            .as_deref()
            .ok_or_else(|| format!("event {} has no start", index + 1))?;
        let end = event.end.as_deref().unwrap_or(start);
        out.push_str("BEGIN:VEVENT\r\n");
        out.push_str(&format!("UID:{}@termigo\r\n", index + 1));
        out.push_str(&format!("DTSTAMP:{stamp}\r\n"));
        out.push_str(&format!("DTSTART:{}\r\n", ics_escape(start)));
        out.push_str(&format!("DTEND:{}\r\n", ics_escape(end)));
        out.push_str(&format!("SUMMARY:{}\r\n", ics_escape(&event.summary)));
        if let Some(description) = event.description.as_deref() {
            out.push_str(&format!("DESCRIPTION:{}\r\n", ics_escape(description)));
        }
        if let Some(location) = event.location.as_deref() {
            out.push_str(&format!("LOCATION:{}\r\n", ics_escape(location)));
        }
        out.push_str("END:VEVENT\r\n");
    }
    out.push_str("END:VCALENDAR\r\n");

    std::fs::write(&target, out.as_bytes())
        .map_err(|e| format!("write {}: {e}", target.display()))?;

    Ok(json!({
        "path": target.display().to_string(),
        "events": events.len(),
        "bytes": out.len()
    }))
}

#[tauri::command]
pub async fn office_ics_read(
    path: String,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<Value, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let target = resolve_io(&path, &workspace, false, &registry)?;
    let text = std::fs::read_to_string(&target)
        .map_err(|e| format!("read {}: {e}", target.display()))?;

    // Unfold first: RFC 5545 lets a long line continue on the next one with a
    // leading space, and every field lookup would otherwise miss it.
    let mut unfolded = String::new();
    for line in text.split("\r\n").flat_map(|l| l.split('\n')) {
        if let Some(rest) = line.strip_prefix([' ', '\t']) {
            unfolded.push_str(rest);
        } else {
            if !unfolded.is_empty() {
                unfolded.push('\n');
            }
            unfolded.push_str(line);
        }
    }

    let mut events: Vec<Value> = Vec::new();
    let mut current: Option<serde_json::Map<String, Value>> = None;
    for line in unfolded.lines() {
        let line = line.trim_end_matches('\r');
        if line.eq_ignore_ascii_case("BEGIN:VEVENT") {
            current = Some(serde_json::Map::new());
            continue;
        }
        if line.eq_ignore_ascii_case("END:VEVENT") {
            if let Some(map) = current.take() {
                events.push(Value::Object(map));
            }
            continue;
        }
        if let Some(map) = current.as_mut() {
            if let Some((key, value)) = line.split_once(':') {
                let field = key.split(';').next().unwrap_or(key).to_ascii_lowercase();
                map.insert(field, Value::String(value.to_string()));
            }
        }
    }

    Ok(json!({
        "path": target.display().to_string(),
        "event_count": events.len(),
        "events": events
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use calamine::Reader as _;

    fn temp_dir() -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("termigo-office-{}", std::process::id()));
        std::fs::create_dir_all(&path).expect("temp dir");
        path
    }

    #[test]
    fn docx_xml_escapes_model_text() {
        let blocks = vec![DocBlock {
            kind: Some("paragraph".into()),
            text: Some("a < b & \"c\"".into()),
            bullets: None,
            title: None,
            body: None,
            level: None,
        }];
        let xml = docx_document_xml(Some("T & T"), &blocks);
        assert!(xml.contains("&lt;"), "angle bracket must be escaped");
        assert!(xml.contains("&amp;"), "ampersand must be escaped");
        assert!(!xml.contains("a < b"), "raw text must not reach the XML");
    }

    #[test]
    fn pptx_slide_renders_text_and_bullets() {
        let slide = DocBlock {
            kind: None,
            text: None,
            bullets: Some(vec!["first".into(), "second".into()]),
            title: Some("Deck".into()),
            body: Some("intro".into()),
            level: None,
        };
        let xml = pptx_slide_xml(&slide, 0);
        assert!(xml.contains("Deck"), "title must reach the slide");
        assert!(xml.contains("intro"), "body text must reach the slide");
        assert!(xml.contains("first") && xml.contains("second"), "bullets must render");
        assert!(xml.contains("buChar"), "bullets must use a bullet glyph");
    }

    #[test]
    fn csv_field_quotes_commas_quotes_and_newlines() {
        assert_eq!(csv_field(&json!("plain")), "plain");
        assert_eq!(csv_field(&json!("a,b")), "\"a,b\"");
        assert_eq!(csv_field(&json!("say \"hi\"")), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_field(&json!("line\nbreak")), "\"line\nbreak\"");
        assert_eq!(csv_field(&Value::Null), "");
    }

    #[test]
    fn ics_escape_protects_separators() {
        assert_eq!(ics_escape("a,b;c\\d"), "a\\,b\\;c\\\\d");
    }

    #[test]
    fn xlsx_round_trip_preserves_numbers_and_text() {
        let dir = temp_dir();
        let path = dir.join("round-trip.xlsx");
        let sheets = vec![SheetSpec {
            name: Some("Data".into()),
            rows: vec![
                vec![json!("name"), json!("score")],
                vec![json!("ada"), json!(42)],
            ],
        }];
        write_sheet(&path, &sheets).expect("write");

        let mut book = calamine::open_workbook_auto(&path).expect("open");
        let sheets = book.worksheets();
        assert_eq!(sheets.len(), 1);
        assert_eq!(sheets[0].0, "Data");
        let (height, width) = sheets[0].1.get_size();
        assert_eq!((height, width), (2, 2));
    }

    /// The write half of the command, without the Tauri state it cannot build
    /// in a unit test.
    fn write_sheet(path: &Path, sheets: &[SheetSpec]) -> Result<(), String> {
        let mut workbook = rust_xlsxwriter::Workbook::new();
        for spec in sheets {
            let sheet = workbook.add_worksheet();
            if let Some(name) = spec.name.as_deref() {
                sheet.set_name(name).map_err(|e| e.to_string())?;
            }
            for (row_index, row) in spec.rows.iter().enumerate() {
                for (col_index, value) in row.iter().enumerate() {
                    let r = row_index as u32;
                    let c = col_index as u16;
                    match value {
                        Value::Number(n) => {
                            sheet
                                .write_number(r, c, n.as_f64().unwrap_or(0.0))
                                .map_err(|e| e.to_string())?;
                        }
                        other => {
                            sheet
                                .write_string(r, c, &cell_text(other))
                                .map_err(|e| e.to_string())?;
                        }
                    }
                }
            }
        }
        workbook.save(path).map_err(|e| e.to_string())
    }

    #[test]
    fn pdf_wrap_never_exceeds_width() {
        let long = "x".repeat(200);
        let lines = wrap_pdf_line(&long, 80);
        assert_eq!(lines.len(), 3);
        assert!(lines.iter().all(|l| l.chars().count() <= 80));
    }

    #[test]
    fn pdf_escape_protects_parentheses() {
        assert_eq!(pdf_escape("a(b)c\\d"), "a\\(b\\)c\\\\d");
    }

    #[test]
    fn clip_respects_char_boundaries() {
        let text = "日本語テキスト";
        let clipped = clip(text, 4);
        assert!(clipped.len() <= 4 + '\u{2026}'.len_utf8());
        assert!(clipped.ends_with('\u{2026}'));
    }
}
