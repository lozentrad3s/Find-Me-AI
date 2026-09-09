/**
 * File-backed resolution store — development and harness runs only.
 *
 * One JSON file, rewritten on every mutation. That is fine for a harness over
 * tens of records and completely wrong for production, which is what the
 * Supabase migration in `supabase/migrations/` is for. The interface is the
 * same, so swapping is a one-line change in the caller.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import type { LatLng } from "@/lib/geo/distance";
import { distanceMetres } from "@/lib/geo/distance";
import type { ResolutionRecord, ResolutionStore } from "./types";

const DEFAULT_PATH = path.join(process.cwd(), ".data", "resolutions.json");

export class FileResolutionStore implements ResolutionStore {
  readonly name = "file";

  constructor(private readonly filePath: string = DEFAULT_PATH) {}

  async save(record: ResolutionRecord): Promise<void> {
    const records = await this.readAll();
    const existing = records.findIndex((r) => r.id === record.id);
    if (existing >= 0) records[existing] = record;
    else records.push(record);
    await this.writeAll(records);
  }

  async confirm(id: string, point: LatLng): Promise<void> {
    await this.mutate(id, (record) => ({
      ...record,
      chosenPoint: point,
      userCorrected: false,
      correctedTo: null,
      confirmedAt: new Date().toISOString(),
    }));
  }

  async correct(id: string, correctedTo: LatLng): Promise<void> {
    await this.mutate(id, (record) => ({
      ...record,
      userCorrected: true,
      correctedTo,
      confirmedAt: new Date().toISOString(),
    }));
  }

  async list(limit = 100): Promise<ResolutionRecord[]> {
    const records = await this.readAll();
    return records
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async nearbyConfirmed(
    point: LatLng,
    radiusM: number,
  ): Promise<ResolutionRecord[]> {
    const records = await this.readAll();

    return records.filter((record) => {
      if (!record.confirmedAt) return false;
      // A corrected record's truth is where the user moved it to, not where
      // the engine originally guessed.
      const truth = record.correctedTo ?? record.chosenPoint;
      if (!truth) return false;
      return distanceMetres(point, truth) <= radiusM;
    });
  }

  // -------------------------------------------------------------------------

  private async mutate(
    id: string,
    update: (record: ResolutionRecord) => ResolutionRecord,
  ): Promise<void> {
    const records = await this.readAll();
    const index = records.findIndex((r) => r.id === id);
    if (index < 0) throw new Error(`No resolution record with id ${id}`);

    const existing = records[index];
    if (!existing) throw new Error(`No resolution record with id ${id}`);

    records[index] = update(existing);
    await this.writeAll(records);
  }

  private async readAll(): Promise<ResolutionRecord[]> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ResolutionRecord[]) : [];
    } catch (error) {
      // A missing file is the normal first-run state, not an error.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeAll(records: ResolutionRecord[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(records, null, 2), "utf8");
  }
}
