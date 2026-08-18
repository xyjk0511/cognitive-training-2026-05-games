import type { A620TrainingGameModule } from "../../typescript/src/game-plugin.js";
import type { CatchLightGameModule } from "../../typescript/src/games/catch-light/adapter.js";

export function hostNeedsConcreteDowncast(module: A620TrainingGameModule, uptimeMs: number, instanceId: string): void {
  // Existing SPI has no frame/input/evidence methods. A host must currently know
  // the concrete module type, which defeats generic training-game dispatch.
  const catchLight = module as CatchLightGameModule;
  catchLight.advanceToUptime(uptimeMs);
  catchLight.touchInstanceAtUptime(instanceId, uptimeMs);
}
