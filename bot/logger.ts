export type LogContext = Readonly<Record<string, string | number | boolean>>;

export interface ServiceLogger {
  info(event: string, context?: LogContext): void;
  warn(event: string, context?: LogContext): void;
  error(event: string, context?: LogContext): void;
}

function write(
  level: 'info' | 'warn' | 'error',
  event: string,
  context: LogContext | undefined,
): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...(context ?? {}),
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}

export const serviceLogger: ServiceLogger = {
  info: (event, context) => write('info', event, context),
  warn: (event, context) => write('warn', event, context),
  error: (event, context) => write('error', event, context),
};
