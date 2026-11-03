import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** A JSON file under `DATA_DIR`. Writes are queued and atomic (temp file + rename), so a crash never leaves half a file. */
export class JsonFile {
  #saving: Promise<void> = Promise.resolve();

  constructor(readonly file: string) {}

  /** The parsed contents, or `undefined` when the file doesn't exist yet. */
  async read(): Promise<unknown> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return JSON.parse(raw);
  }

  /** Renames an unreadable file out of the way, keeping it for a person to look at, and returns where it went. */
  async setAside(): Promise<string> {
    const aside = `${this.file}.corrupt`;
    await rename(this.file, aside);
    return aside;
  }

  write(data: unknown): Promise<void> {
    const text = `${JSON.stringify(data, null, 2)}\n`;
    this.#saving = this.#saving
      .catch(() => {})
      .then(async () => {
        await mkdir(path.dirname(this.file), { recursive: true });
        const temp = `${this.file}.tmp`;
        await writeFile(temp, text);
        await rename(temp, this.file);
      });
    return this.#saving;
  }
}
