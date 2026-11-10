// 截图转成发给 omem 的 base64。整页长图可能有十几 MB：超过 6 MB 时转成 WebP（清晰度几乎不变，体积小很多），
// 仍然太大就按比例缩小。服务端单张上限 15 MB。

const SOFT_LIMIT = 6 * 1024 * 1024;

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function reencode(blob: Blob, scale: number): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.convertToBlob({ type: "image/webp", quality: 0.88 });
}

export async function imageForUpload(blob: Blob): Promise<string> {
  if (blob.size <= SOFT_LIMIT) return toBase64(blob);
  let next = await reencode(blob, 1);
  for (const scale of [0.75, 0.5]) {
    if (next.size <= SOFT_LIMIT) break;
    next = await reencode(blob, scale);
  }
  return toBase64(next);
}
