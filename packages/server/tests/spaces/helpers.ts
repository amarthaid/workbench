import fs from "node:fs";
import path from "node:path";
import { createGzip } from "node:zlib";
import { pack as tarPack } from "tar-stream";
import { db } from "../../src/db";

export async function resetSpacesDb(): Promise<void> {
  for (const t of ["space_kv", "space_consents", "space_shares", "spaces", "pending_auth", "users", "audit_log"]) {
    await db.exec(`DELETE FROM ${t}`);
  }
}

export async function seedUser(id: string, email: string | null): Promise<void> {
  await db.run("INSERT INTO users (id, email) VALUES (?, ?)", [id, email]);
}

/** Write files straight into <root>/<name>/, as if an upload had landed. */
export function writeSpaceFiles(root: string, name: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(root, name, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
}

export function tarball(files: Array<{ name: string; content: string }>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tarPack();
    const gzip = createGzip();
    const chunks: Buffer[] = [];
    gzip.on("data", (c: Buffer) => chunks.push(c));
    gzip.on("end", () => resolve(Buffer.concat(chunks)));
    gzip.on("error", reject);
    pack.pipe(gzip);
    (function next(i: number) {
      if (i >= files.length) {
        pack.finalize();
        return;
      }
      pack.entry({ name: files[i].name }, files[i].content, () => next(i + 1));
    })(0);
  });
}
