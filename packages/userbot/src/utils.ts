export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        const maybeCause = error as Error & { cause?: unknown };
        if (
            typeof maybeCause.cause === "object" &&
            maybeCause.cause !== null &&
            "message" in maybeCause.cause &&
            typeof (maybeCause.cause as { message?: unknown }).message === "string"
        ) {
            return (maybeCause.cause as { message: string }).message;
        }

        const compact = error.message.split("\nparams:")[0];
        if (compact.length > 400) {
            return `${compact.slice(0, 397)}...`;
        }

        return compact;
    }

    return String(error);
}

export function parseStatusCodeFromError(error: unknown): number | null {
    if (!(error instanceof Error)) {
        return null;
    }

    const match = error.message.match(/status\s+(\d{3})/i);
    if (!match) {
        return null;
    }

    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
}

export function chunkArray<T>(items: T[], chunkSize: number): T[][] {
    if (chunkSize <= 0) {
        return [items];
    }

    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += chunkSize) {
        chunks.push(items.slice(i, i + chunkSize));
    }

    return chunks;
}
