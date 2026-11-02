"""OlahPDF worker — daftar processor per tool."""
from .convert import (html_to_pdf, jpg_to_pdf, office_to_pdf, pdf_to_excel, pdf_to_jpg, pdf_to_pdfa,
                      pdf_to_ppt, pdf_to_word)
from .edit import edit_pdf
from .organize import compress_pdf, merge_pdf, split_pdf
from .security import unlock_pdf, watermark_pdf
from .unwatermark import remove_watermark

PROCESSORS = {
    # ke PDF
    "jpg-to-pdf": jpg_to_pdf,
    "word-to-pdf": office_to_pdf,
    "powerpoint-to-pdf": office_to_pdf,
    "excel-to-pdf": office_to_pdf,
    "html-to-pdf": html_to_pdf,
    # dari PDF
    "pdf-to-jpg": pdf_to_jpg,
    "pdf-to-word": pdf_to_word,
    "pdf-to-powerpoint": pdf_to_ppt,
    "pdf-to-excel": pdf_to_excel,
    "pdf-to-pdfa": pdf_to_pdfa,
    # atur
    "merge": merge_pdf,
    "split": split_pdf,
    "compress": compress_pdf,
    # keamanan & edit
    "watermark": watermark_pdf,
    "unlock": unlock_pdf,
    "remove-watermark": remove_watermark,
    "edit": edit_pdf,
}
