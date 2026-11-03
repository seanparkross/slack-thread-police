import { z } from "zod";
import { JsonFile } from "./jsonfile.js";

const FileSchema = z.object({ optOuts: z.record(z.string(), z.number().nullable()) });

export type NudgeStatus = { optedOut: false } | { optedOut: true; until: number | null };

/**
 * Who has turned nudges off, and until when (`null` means until they turn them back on). Saved as
 * user ids and times, never message content.
 */
export class PreferenceStore {
  private constructor(
    private readonly file: JsonFile | undefined,
    private readonly optOuts: Map<string, number | null>,
  ) {}

  /** Reads `file` if it exists. Without a file, preferences live in memory only. */
  static async load(file?: string): Promise<PreferenceStore> {
    if (!file) return new PreferenceStore(undefined, new Map());
    const json = new JsonFile(file);
    const data = await json.read();
    if (data === undefined) return new PreferenceStore(json, new Map());
    const parsed = FileSchema.safeParse(data);
    if (!parsed.success) throw new Error(`${file} isn't a valid preferences file; fix or delete it.`);
    return new PreferenceStore(json, new Map(Object.entries(parsed.data.optOuts)));
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

  #save(): Promise<void> {
    return this.file?.write({ optOuts: Object.fromEntries(this.optOuts) }) ?? Promise.resolve();
  }
}
