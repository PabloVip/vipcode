import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findProgram } from "./shell.js";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// Las imágenes más grandes que esto no se mandan (los proveedores las rechazan)
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function isImagePath(file: string): boolean {
  return Boolean(MIME[path.extname(file).toLowerCase()]);
}

export function imageMime(file: string): string {
  return MIME[path.extname(file).toLowerCase()] || "image/png";
}

// Convierte un fichero de imagen en data URL (data:image/png;base64,...)
export function toDataUrl(file: string): string {
  const stat = fs.statSync(file);
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error(`La imagen ${path.basename(file)} ocupa más de 8 MB`);
  }
  return `data:${imageMime(file)};base64,${fs.readFileSync(file).toString("base64")}`;
}

function run(command: string, args: string[]): Promise<{ code: number; stdout: Buffer }> {
  return new Promise((resolve) => {
    // Por su ruta completa: nunca un programa con ese nombre que haya en la carpeta del proyecto
    const file = findProgram(command);
    if (!file) {
      resolve({ code: 127, stdout: Buffer.alloc(0) });
      return;
    }
    execFile(file, args, { encoding: "buffer", maxBuffer: 32 * 1024 * 1024, timeout: 10000 }, (err, stdout) => {
      let code = 0;
      if (err) {
        code = typeof (err as any).code === "number" ? (err as any).code : 1;
      }
      resolve({ code, stdout: stdout || Buffer.alloc(0) });
    });
  });
}

// La imagen que ha dejado el portapapeles en un fichero temporal (y lo borra)
function takePng(tmp: string): string | null {
  try {
    const size = fs.statSync(tmp).size;
    if (size === 0) {
      return null;
    }
    return `data:image/png;base64,${fs.readFileSync(tmp).toString("base64")}`;
  } catch {
    return null;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Lee una imagen del portapapeles (macOS con osascript, Windows con PowerShell, Linux con wl-paste o xclip)
export async function readClipboardImage(): Promise<string | null> {
  const tmp = path.join(os.tmpdir(), `vipcode-clip-${process.pid}-${Date.now()}.png`);
  if (process.platform === "darwin") {
    const script = [
      `set f to open for access POSIX file "${tmp}" with write permission`,
      "try",
      "write (the clipboard as «class PNGf») to f",
      "end try",
      "close access f",
    ];
    const args: string[] = [];
    for (const line of script) {
      args.push("-e", line);
    }
    await run("osascript", args);
    return takePng(tmp);
  }
  if (process.platform === "win32") {
    // El PowerShell que trae Windows, con el portapapeles de .NET (que necesita -STA)
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -AssemblyName System.Drawing",
      "$image = [System.Windows.Forms.Clipboard]::GetImage()",
      `if ($image) { $image.Save('${tmp.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png) }`,
    ].join("\n");
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
    return takePng(tmp);
  }
  if (process.platform === "linux") {
    for (const [command, args] of [
      ["wl-paste", ["--type", "image/png"]],
      ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
    ] as [string, string[]][]) {
      const result = await run(command, args);
      if (result.code === 0 && result.stdout.length > 100) {
        return `data:image/png;base64,${result.stdout.toString("base64")}`;
      }
    }
  }
  return null;
}
