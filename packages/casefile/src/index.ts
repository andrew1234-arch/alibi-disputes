import type { ChecklistItem, EvidenceRecord, RequestedEvidence } from "@alibi/core";

// Case-file engine interface (SPEC §6.2). The minimal in-repo implementation
// lands in M3; Poirot's engine may be swapped in behind this interface after
// Poirot is submitted (no earlier — see SPEC §6.2).

/** Reason → accepted evidence types → merchant fact kinds. Defined in @alibi/core (M1). */
export type ReasonEvidenceMap = Record<string, Record<string, EvidenceRecord["kind"][]>>;

export interface CaseEngine {
  ingest(records: EvidenceRecord[]): void;
  timeline(): EvidenceRecord[];
  satisfy(requested: RequestedEvidence[], map: ReasonEvidenceMap): ChecklistItem[];
}
