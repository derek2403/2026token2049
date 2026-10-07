// The intents IDL, written by `anchor build` and copied to idl/intents.json.
// Isolated here so nothing else imports the JSON's literal type.

import type { Idl } from "@coral-xyz/anchor";
import intentsIdl from "../../idl/intents.json";

export const INTENTS_IDL = intentsIdl as unknown as Idl;
