/** Keep existing summary calls and ReturnType consumers compatible with the display overload. */
import {
  summarizeInitResult,
  type InitConciseResult,
  type InitDisplayResult,
  type InitResult,
} from "../../src/sdk/index.js";

declare const initialized: InitResult;
const existing: InitConciseResult = summarizeInitResult(initialized);
const compatibleReturn: ReturnType<typeof summarizeInitResult> = existing;
const compatibleParameters: Parameters<typeof summarizeInitResult> = [initialized];
const display: InitDisplayResult = summarizeInitResult(initialized, true);
void compatibleReturn;
void compatibleParameters;
void display;
