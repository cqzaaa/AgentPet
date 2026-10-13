// stdout is reserved for the JSON result; library logs go to stderr.
export const DOCLING_SCRIPT = String.raw`
import contextlib, json, os, sys
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
    options = PdfPipelineOptions()
    options.do_ocr = True
    options.ocr_options = RapidOcrOptions(backend="onnxruntime")
    options.do_table_structure = True
    options.table_structure_options.mode = TableFormerMode.ACCURATE
    options.enable_remote_services = False
    converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
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
    output = {"blocks": blocks, "pageCount": len(document.pages), "status": result.status.value}
print(json.dumps(output, ensure_ascii=False))
`
