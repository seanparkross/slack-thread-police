import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const FileSchema = z.object({ optOuts: z.record(z.string(), z.number().nullable()) });

export type NudgeStatus = { optedOut: false } | { optedOut: true; until: number | null };

/**
 * Who has turned nudges off, and until when (`null` means until they turn them back on). This is
 * the only thing the bot writes to disk, and it holds user ids and times, never message content.
 */
export class PreferenceStore {
  #saving: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: string | undefined,
    private readonly optOuts: Map<string, number | null>,
  ) {}

  /** Reads `file` if it exists. Without a file, preferences live in memory only. */
  static async load(file?: string): Promise<PreferenceStore> {
    if (!file) return new PreferenceStore(undefined, new Map());
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new PreferenceStore(file, new Map());
      throw error;
    }
    const parsed = FileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error(`${file} isn't a valid preferences file; fix or delete it.`);
    return new PreferenceStore(file, new Map(Object.entries(parsed.data.optOuts)));
  }

  status(user: string, now = Date.now()): NudgeStatus {
    const until = this.optOuts.get(user);
    if (until === undefined) return { optedOut: false };
    if (until !== null && until <= now) {
      this.optOuts.delete(user);
      return { optedOut: false };
    }
    return { optedOut: true, until };
  }

  isOptedOut(user: string, now = Date.now()): boolean {
    return this.status(user, now).optedOut;
  }

  optOut(user: string, until: number | null): Promise<void> {
    this.optOuts.set(user, until);
    return this.#save();
  }

  optIn(user: string): Promise<void> {
    this.optOuts.delete(user);
    return this.#save();
  }

  /** Writes are queued and atomic (temp file + rename), so a crash never leaves half a file. */
  #save(): Promise<void> {
    const file = this.file;
    if (!file) return Promise.resolve();
    const data = `${JSON.stringify({ optOuts: Object.fromEntries(this.optOuts) }, null, 2)}\n`;
    this.#saving = this.#saving
      .catch(() => {})
      .then(async () => {
        await mkdir(path.dirname(file), { recursive: true });
        const temp = `${file}.tmp`;
        await writeFile(temp, data);
        await rename(temp, file);
      });
    return this.#saving;
  }
}
