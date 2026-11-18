import { ApplicationError } from "../core/errors";

export interface ProviderReadiness {
  id: "doubao";
  state: "unverified";
  message: string;
}

/** Real generation is added here after verifying the target account's free entry points. */
export class DoubaoProvider {
  readiness(): ProviderReadiness {
    return {
      id: "doubao",
      state: "unverified",
      message: "豆包免费对话、生图和首尾帧生视频入口待实际验证。",
    };
  }

  requireVerifiedEntry(): never {
    throw new ApplicationError(
      "PROVIDER_UNAVAILABLE",
      this.readiness().message,
    );
  }
}
