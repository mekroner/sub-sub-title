/**
 * The webview's side of overlay templates: turning an image file into an
 * embedded PNG, and writing embedded PNGs back out beside a project.
 */

import type { Edit } from "../types";
import { readImageFile, writeAssetPng } from "./api";
import { hashString, splitPath } from "./editPlan";
import { projectName } from "./projectFile";
import { base64ToBytes, bytesToBase64, type OverlayTemplate, type TemplateImage } from "./template";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

/** A PNG's size, from its header. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** An image file as a template carries it: a PNG, named after its contents. */
export async function encodeImagePng(path: string): Promise<{ name: string } & TemplateImage> {
  let bytes = await readImageFile(path);
  let size: { width: number; height: number };
  if (isPng(bytes)) {
    size = pngSize(bytes);
  } else {
    // Anything else is redrawn as a PNG, so every embedded image is one.
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error(`Could not convert ${path} to PNG.`);
    bytes = new Uint8Array(await blob.arrayBuffer());
    size = { width: bitmap.width, height: bitmap.height };
  }
  const png = bytesToBase64(bytes);
  return { name: `img-${hashString(png)}.png`, ...size, png };
}

/**
 * Where a project keeps the images its templates brought: `<stem> assets`
 * beside the project file, or beside the first source while it is unsaved.
 */
export function assetsFolder(projectPath: string | null, edit: Edit): string | null {
  const anchor = projectPath ?? edit.sources[0]?.path;
  if (!anchor) return null;
  const { dir, sep } = splitPath(anchor);
  const stem = projectName(anchor);
  return `${dir ? dir + sep : ""}${stem} assets`;
}

/** Writes a template's images into `folder`; returns where each went. */
export async function writeTemplateImages(
  template: OverlayTemplate,
  folder: string,
): Promise<Map<string, string>> {
  const sep = folder.includes("\\") && !folder.includes("/") ? "\\" : "/";
  const paths = new Map<string, string>();
  for (const [name, image] of Object.entries(template.images)) {
    const path = `${folder}${sep}${name}`;
    await writeAssetPng(path, base64ToBytes(image.png));
    paths.set(name, path);
  }
  return paths;
}
