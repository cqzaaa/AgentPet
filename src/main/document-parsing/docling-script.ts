// stdout is reserved for the JSON result; library logs go to stderr.
export const DOCLING_SCRIPT = String.raw`
import contextlib, json, math, os, re, sys
sys.path.insert(0, sys.argv[1])
with contextlib.redirect_stdout(sys.stderr):
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    if proxy:
        import requests
        from huggingface_hub import configure_http_backend
        def http_backend():
            session = requests.Session()
            # Explicitly use Electron's proxy instead of Python's differing Windows discovery.
            session.trust_env = False
            session.proxies["https"] = proxy
            session.verify = os.environ.get("REQUESTS_CA_BUNDLE") or os.environ.get("CURL_CA_BUNDLE") or True
            from requests.adapters import HTTPAdapter
            from urllib3.util.retry import Retry
            session.mount("https://", HTTPAdapter(max_retries=Retry(total=3, backoff_factor=1)))
            return session
        configure_http_backend(http_backend)
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, RapidOcrOptions, TableFormerMode
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
    # PDFs can have a perfectly readable page but a broken embedded character map.
    # Automatic OCR otherwise trusts those existing cells and leaves the garbage intact.
    damaged_pages = []
    if sys.argv[2] != "--prepare":
        import fitz
        with fitz.open(sys.argv[2]) as source:
            for page_index, page in enumerate(source):
                native_text = page.get_text()
                visible = re.sub(r"\s", "", native_text)
                damaged = native_text.count("\ufffd") + sum(len(m.group()) for m in re.finditer(r"/(?:G[0-9A-F]{2,4})|\(cid:\d+\)", native_text))
                # Some typeset papers map Latin letters/numbers to printable ASCII
                # punctuation, so replacement-character checks alone miss the damage.
                broken_font_map = False
                for font in page.get_fonts():
                    encoding_kind, encoding_ref = source.xref_get_key(font[0], "Encoding")
                    if encoding_kind != "xref":
                        continue
                    encoding = source.xref_object(int(encoding_ref.split()[0]))
                    anonymous_glyphs = len(re.findall(r"/G[0-9A-Fa-f]{2,4}\b", encoding))
                    if anonymous_glyphs < 8:
                        continue
                    cmap_kind, cmap_ref = source.xref_get_key(font[0], "ToUnicode")
                    cmap = source.xref_stream(int(cmap_ref.split()[0])) if cmap_kind == "xref" else b""
                    mapped = len(re.findall(rb"<[0-9A-Fa-f]+>\s*<[0-9A-Fa-f]+>", cmap or b""))
                    if mapped < anonymous_glyphs / 2:
                        broken_font_map = True
                        break
                if broken_font_map or (damaged >= 8 and damaged / max(1, len(visible)) > 0.02):
                    damaged_pages.append(page_index + 1)
    options = PdfPipelineOptions()
    options.do_ocr = True
    # RapidOCR initializes its visualization font even during plain recognition.
    # Use the installed CJK font instead of an unexpected download in offline mode.
    local_font = os.path.join(os.environ.get("WINDIR", "C:/Windows"), "Fonts", "msyh.ttc")
    options.ocr_options = RapidOcrOptions(backend="onnxruntime", force_full_page_ocr=bool(damaged_pages),
                                         font_path=local_font if os.path.isfile(local_font) else None)
    options.do_table_structure = True
    options.table_structure_options.mode = TableFormerMode.ACCURATE
    options.enable_remote_services = False
    # PDFium also avoids docling-parse's native resource-path failure on Windows
    # installations under non-ASCII user names.
    converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(
        pipeline_options=options, backend=PyPdfiumDocumentBackend)})
    if sys.argv[2] == "--prepare":
        converter.initialize_pipeline(InputFormat.PDF)
        print(json.dumps({"status": "ready"}), file=sys.__stdout__)
        sys.exit(0)
    result = converter.convert(sys.argv[2])
    document = result.document
    blocks = []
    for item, level in document.iterate_items():
        label = item.label.value
        if label in ("page_header", "page_footer"):
            continue
        text = getattr(item, "text", "")
        if label == "table":
            text = item.export_to_markdown(doc=document)
        if not text.strip():
            continue
        sources = []
        for prov in getattr(item, "prov", []):
            bbox = prov.bbox
            sources.append({"page": prov.page_no, "bbox": [bbox.l, bbox.t, bbox.r, bbox.b],
                            "coordOrigin": bbox.coord_origin.value})
        blocks.append({"label": label, "level": getattr(item, "level", level), "text": text,
                       "ref": item.self_ref, "sources": sources})
    def finite_score(value):
        return float(value) if value is not None and math.isfinite(float(value)) else None
    confidence = result.confidence
    output = {"blocks": blocks, "pageCount": len(document.pages), "status": result.status.value,
              "forcedOcrPages": damaged_pages, "fullPageOcr": bool(damaged_pages),
              "confidence": {key: finite_score(getattr(confidence, key, None))
                             for key in ("mean_score", "layout_score", "ocr_score", "table_score")}}
print(json.dumps(output, ensure_ascii=False))
`
