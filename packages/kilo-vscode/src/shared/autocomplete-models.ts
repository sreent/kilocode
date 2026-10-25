import { AUTOCOMPLETE_MODELS as ALL } from "@kilocode/kilo-gateway/autocomplete"

// tucode has no Kilo Gateway, so it offers only the models people reach through a Mistral or
// Inception provider they connect themselves.
export const AUTOCOMPLETE_MODELS = ALL.filter((m) => m.providerID !== "kilo")

export {
  DEFAULT_AUTOCOMPLETE_MODEL,
  getAutocompleteModel,
  getAutocompleteModelById,
  validAutocompleteModel,
  validAutocompleteProvider,
  type AutocompleteModelDef,
  type AutocompleteProviderID,
} from "@kilocode/kilo-gateway/autocomplete"
