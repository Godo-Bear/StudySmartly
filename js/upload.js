// StudySmartly — shared picture handling (admin panel + Create page).
// Any picture the browser can open, or a PDF (its first page is used),
// is redrawn as a small WebP so it's quick to save and load.
const MAX_SIDE = 512;
const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174";

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(/hei[cf]/i.test(file.type + file.name)
        ? "iPhone HEIC photos don't work in this browser. Take a screenshot of it, or save it as JPG, and upload that."
        : "That file isn't a picture this browser can open. Try a PNG, JPG or PDF."));
    };
    img.src = url;
  });
}

let pdfjsReady;
function loadPdfJs() {
  pdfjsReady ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `${PDFJS}/pdf.min.js`;
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.js`;
      resolve(window.pdfjsLib);
    };
    s.onerror = () => { pdfjsReady = null; reject(new Error("Couldn't load the PDF reader. Check your internet and try again.")); };
    document.head.appendChild(s);
  });
  return pdfjsReady;
}
async function renderPdf(file) {
  const pdfjs = await loadPdfJs();
  let pdf;
  try {
    pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  } catch {
    throw new Error("That PDF couldn't be opened. It may be damaged or password-protected.");
  }
  const page = await pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: (MAX_SIDE * 2) / Math.max(base.width, base.height) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // PDFs are see-through by default
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  pdf.destroy();
  return canvas;
}

async function processImage(file) {
  if (file.size > 25 * 1024 * 1024) throw new Error("That file is too big (max 25 MB).");
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  const src = isPdf ? await renderPdf(file) : await loadImage(file);
  const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
  if (!w || !h) throw new Error("That picture looks empty.");
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext("2d").drawImage(src, 0, 0, canvas.width, canvas.height);
  let dataURL = canvas.toDataURL("image/webp", 0.85);
  if (!dataURL.startsWith("data:image/webp")) dataURL = canvas.toDataURL("image/jpeg", 0.88);
  const [head, base64] = dataURL.split(",");
  return { dataURL, base64, type: head.slice(5, head.indexOf(";")) };
}
