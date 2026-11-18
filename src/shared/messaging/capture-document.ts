import { isCaptureFillRequestMessage, isCaptureFillOutcome, type CaptureFillRequestMessage, type CaptureFillOutcome } from './capture';
import { isTotpVerificationRequest } from './totp-capture';
import type { CapturedTotpIdentityFields } from '../totp-capture';
export const CAPTURE_DOCUMENT_PORT = 'palladin.capture.document.v1';
export type CaptureDocumentRequest = CaptureFillRequestMessage | {
    channel: 'palladin.totp-capture';
    type: 'verify-page';
    expected: CapturedTotpIdentityFields;
};
export type CaptureDocumentReply = boolean | CaptureFillOutcome;
export function isCaptureDocumentRequest(value: unknown): value is CaptureDocumentRequest { return isCaptureFillRequestMessage(value) || isTotpVerificationRequest(value); }
export function isCaptureDocumentReply(value: unknown): value is CaptureDocumentReply { return typeof value === 'boolean' || isCaptureFillOutcome(value); }
