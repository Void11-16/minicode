export { checkRequirements, parseRequirements } from "../tools/travel-requirements.ts";
export type {
  TravelRequirements as EvalRequirements,
  TravelTimeWindow as EvalTimeWindow,
  TravelRequirementCheck as EvalRequirementCheck,
} from "../tools/travel-requirements.ts";
import type { TravelRequirementCheck } from "../tools/travel-requirements.ts";

export function requirementFailures(metrics: { readonly requirementChecks?: readonly TravelRequirementCheck[] }): string[] {
  return (metrics.requirementChecks ?? []).filter((check) => !check.passed).map((check) => `${check.code}: ${check.message}`);
}
