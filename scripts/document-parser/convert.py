"""Docling conversion, offline and local-file only. stdout is a single result."""
import os
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
import sys, json, pathlib, importlib.metadata
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling.datamodel.base_models import InputFormat, ConversionStatus
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling_core.types.doc import ImageRefMode, PictureItem, TableItem

source = pathlib.Path(sys.argv[1])
options = PdfPipelineOptions()
options.do_ocr = False  # This first path reads text PDFs; scans must not silently succeed.
options.generate_picture_images = True
options.enable_remote_services = False
if len(sys.argv) > 2 and sys.argv[2]:
    options.artifacts_path = pathlib.Path(sys.argv[2])
elif source.suffix.lower() == ".pdf":
    raise ValueError("PDF 解析模型未准备；请运行 osdk run documents:models。DOCX 无需模型。")
converter = DocumentConverter(allowed_formats=[InputFormat.PDF, InputFormat.DOCX], format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
result = converter.convert(source, max_file_size=20_000_000, max_num_pages=200)
if result.status != ConversionStatus.SUCCESS:
    raise ValueError("文档解析不完整，请检查原件后重试：" + str(result.status))
doc = result.document
markdown = doc.export_to_markdown(image_mode=ImageRefMode.PLACEHOLDER)
if not markdown.strip():
    raise ValueError("没有识别到可读正文；扫描件需要 OCR，当前入口只支持文字 PDF 和 DOCX。")
blocks = []
for item, level in doc.iterate_items():
    text = getattr(item, "text", "")
    if isinstance(item, TableItem):
        text = item.export_to_markdown(doc=doc)
    image = None
    if isinstance(item, PictureItem):
        picture = item.get_image(doc)
        if picture:
            import io, base64
            buffer = io.BytesIO()
            picture.save(buffer, format="PNG")
            image = base64.b64encode(buffer.getvalue()).decode()
    if text or image:
        blocks.append({"ref": item.self_ref, "label": str(item.label.value), "level": level,
                       "headingLevel": getattr(item, "level", None),
                       "text": text, "provenance": [p.model_dump(mode="json") for p in item.prov], "image": image})
print(json.dumps({"parserVersion": importlib.metadata.version("docling"), "markdown": markdown,
                  "document": doc.export_to_dict(), "blocks": blocks, "pageCount": len(doc.pages),
                  "warnings": ["扫描件 OCR 尚未启用，请对照原件检查图中未提取的文字。"] if source.suffix.lower() == ".pdf" else []}, ensure_ascii=False))
