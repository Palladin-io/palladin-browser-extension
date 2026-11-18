/** Legacy route IDs identify original Ports, never browser-issued documents. */
export interface CaptureDocumentIdentity {
    readonly browserDocumentId?: string;
    readonly legacyRouteId?: string;
}
export function captureDocumentKey(source: CaptureDocumentIdentity): string {
    if (source.browserDocumentId && !source.legacyRouteId)
        return source.browserDocumentId;
    if (source.legacyRouteId && !source.browserDocumentId)
        return `legacy:${source.legacyRouteId}`;
    return '';
}
export function captureTopDocumentKey(source: CaptureDocumentIdentity & {
    topDocumentId?: string;
    legacyTopRouteId?: string;
}): string {
    return source.legacyTopRouteId ? `legacy:${source.legacyTopRouteId}` : source.topDocumentId ?? '';
}
