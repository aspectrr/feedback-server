import { domToPng } from "modern-screenshot";

const MAX_BYTES = 4 * 1024 * 1024; // server-side cap
const MAX_WIDTH = 1600;

// Exclude the widget's own DOM from captures.
const filter = (el: Node) =>
  !(el instanceof Element && el.hasAttribute("data-feedback-widget"));

/**
 * Capture the current page and return [dataUrl, mime].
 * Downscales to <=1600px wide; falls back to JPEG if the PNG would bust the
 * server's 4MB base64 cap.
 */
export async function capturePage(): Promise<[string, string]> {
  const scale = Math.min(1, MAX_WIDTH / window.innerWidth);
  const dataUrl = await domToPng(document.body, { filter, scale });
  return downscale(dataUrl);
}

async function downscale(dataUrl: string): Promise<[string, string]> {
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = () => res(null);
    img.onerror = () => rej(new Error("screenshot decode failed"));
    img.src = dataUrl;
  });
  const w = Math.min(img.naturalWidth, MAX_WIDTH);
  const h = Math.round((img.naturalHeight / img.naturalWidth) * w);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
  let out = canvas.toDataURL("image/png");
  if (out.length > (MAX_BYTES / 3) * 4) out = canvas.toDataURL("image/jpeg", 0.85);
  return [out, out.slice(5, out.indexOf(";"))];
}
