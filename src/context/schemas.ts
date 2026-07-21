/**
 * JSON value supported by VEAW context schemas.
 */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * JSON object supported by VEAW context schemas.
 */
export type JsonObject = Readonly<Record<string, JsonValue>>;

/**
 * Evidence attached to generated context.
 */
export interface ContextEvidence {
  readonly source: 'screenshot' | 'catalog' | 'mcp' | 'project' | 'context' | 'file' | 'generated';
  readonly ref: string;
  readonly note: string;
  readonly confidence: number;
}

/**
 * Graceful degradation record.
 */
export interface Degradation {
  readonly code: string;
  readonly reason: string;
  readonly fallback: string;
}

/**
 * Observable screenshot structure item.
 */
export interface ScreenshotObservation {
  readonly kind: 'layout' | 'control' | 'hierarchy' | 'state' | 'spacing' | 'unknown';
  readonly description: string;
  readonly evidenceRef: string;
  readonly confidence: number;
}

/**
 * Screenshot context schema.
 */
export interface ScreenshotContext {
  readonly schema: 'screenshot-context';
  readonly version: '1.0.0';
  readonly generatedAt: string;
  readonly available: boolean;
  readonly reference?: string;
  readonly route?: string;
  readonly viewport?: string;
  readonly source: 'user-provided' | 'local-test' | 'missing';
  readonly permission: 'explicit' | 'not-provided';
  readonly relatedComponents: readonly string[];
  readonly observations: readonly ScreenshotObservation[];
  readonly evidence: readonly ContextEvidence[];
  readonly degradations: readonly Degradation[];
}

/**
 * Component API summary.
 */
export interface ComponentApiSummary {
  readonly props: readonly string[];
  readonly emits: readonly string[];
  readonly slots: readonly string[];
}

/**
 * Component candidate from catalog or MCP.
 */
export interface ComponentCandidate {
  readonly name: string;
  readonly source: 'catalog' | 'mcp';
  readonly reference: string;
  readonly category?: string;
  readonly isShared?: boolean;
  readonly api: ComponentApiSummary;
  readonly examples: readonly string[];
  readonly dependencies: readonly string[];
  readonly usageHints: readonly string[];
  readonly matchReason: string;
  readonly evidence: readonly ContextEvidence[];
}

/**
 * Component query result schema.
 */
export interface ComponentQueryResult {
  readonly schema: 'component-query-result';
  readonly version: '1.0.0';
  readonly query: string;
  readonly candidates: readonly ComponentCandidate[];
  readonly evidence: readonly ContextEvidence[];
  readonly degradations: readonly Degradation[];
}

/**
 * UI component context merged from screenshot, catalog, and optional MCP.
 */
export interface UiComponentContext {
  readonly schema: 'ui-component-context';
  readonly version: '1.0.0';
  readonly generatedAt: string;
  readonly screenshot: ScreenshotContext;
  readonly candidates: readonly ComponentCandidate[];
  readonly risks: readonly string[];
  readonly uncertainties: readonly string[];
  readonly alternatives: readonly string[];
  readonly degradations: readonly Degradation[];
}

/**
 * Design context schema.
 */
export interface DesignContext {
  readonly schema: 'design-context';
  readonly version: '1.0.0';
  readonly requirement: string;
  readonly layout: readonly string[];
  readonly interactions: readonly string[];
  readonly responsive: readonly string[];
  readonly componentReuse: readonly ComponentCandidate[];
  readonly constraints: readonly string[];
  readonly uncertainties: readonly string[];
  readonly evidence: readonly ContextEvidence[];
  readonly degradations: readonly Degradation[];
}

/**
 * Ordered task list schema.
 */
export interface TaskList {
  readonly schema: 'task-list';
  readonly version: '1.0.0';
  readonly requirement: string;
  readonly tasks: readonly TaskItem[];
  readonly degradations: readonly Degradation[];
}

/**
 * Task item schema.
 */
export interface TaskItem {
  readonly order: number;
  readonly goal: string;
  readonly files: readonly string[];
  readonly dependencies: readonly string[];
  readonly verification: readonly string[];
  readonly doneDefinition: string;
  readonly risks: readonly string[];
}

/**
 * Review finding severity.
 */
export type ReviewSeverity = 'info' | 'warning' | 'error';

/**
 * Review finding schema.
 */
export interface ReviewFinding {
  readonly severity: ReviewSeverity;
  readonly title: string;
  readonly evidence: readonly string[];
  readonly recommendation: string;
}

/**
 * Review result schema.
 */
export interface ReviewResult {
  readonly schema: 'review-result';
  readonly version: '1.0.0';
  readonly ok: boolean;
  readonly findings: readonly ReviewFinding[];
  readonly residualRisks: readonly string[];
  readonly testGaps: readonly string[];
}

/**
 * Shared machine-readable context schema catalog.
 */
export const CONTEXT_SCHEMA_CATALOG = {
  version: '1.0.0',
  schemas: [
    'screenshot-context',
    'component-query-result',
    'ui-component-context',
    'design-context',
    'task-list',
    'review-result',
  ],
} as const satisfies JsonObject;
