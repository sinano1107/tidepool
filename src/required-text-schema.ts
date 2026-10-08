import { z } from "zod";
import { normalizeText, whyBlank } from "./required-text.js";

/** Server adapter; the browser bundles only the text functions. */
export const requiredTextSchema = z.string().transform(normalizeText).superRefine((value, ctx) => {
  const reason = whyBlank(value);
  if (reason) ctx.addIssue({ code: "custom", message: reason });
});
