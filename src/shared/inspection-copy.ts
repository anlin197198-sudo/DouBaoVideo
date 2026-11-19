import type { buildInspectionSummary } from "./inspection-summary";
import type { ImagePreviewState } from "./image-preview-state";
export type InspectionSummaryValue = ReturnType<typeof buildInspectionSummary>;
export interface InspectionCopyToken { readonly operation: number; readonly text: string }
/** Controls clipboard feedback only. It cannot retract an already requested OS clipboard write. */
export class InspectionCopy {
  #key = ""; #operation = 0; #pending = false; #text: string | null = null;
  observe(summary: InspectionSummaryValue, images: ImagePreviewState, busy: boolean): boolean {
    const eligible = !busy && !!summary.saved?.confirmation.coherent && !!summary.saved.video?.text.trim()
      && summary.saved.frames.length === 2 && summary.saved.frames.every(f => f.previewStatus === "ready");
    const key = JSON.stringify({summary, epochs: summary.saved?.frames.map(f => f.imageId ? images[f.imageId]?.epoch : null), busy});
    if (key !== this.#key) { this.#key = key; this.#operation++; this.#pending = false; }
    this.#text = eligible ? summary.saved!.video!.text : null;
    return eligible;
  }
  begin(): InspectionCopyToken | null {
    if (this.#pending || this.#text === null) return null;
    this.#pending = true;
    return Object.freeze({operation:++this.#operation,text:this.#text});
  }
  current(token: InspectionCopyToken): boolean { return this.#pending && token.operation === this.#operation && token.text === this.#text; }
  finish(token: InspectionCopyToken): boolean { if (!this.current(token)) return false; this.#pending = false; return true; }
  cancel(): void { this.#operation++; this.#pending = false; this.#text = null; }
}
