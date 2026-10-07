export interface TraceAttributes {
  [key: string]: string | number | boolean
}

export interface Span {
  end(err?: Error, attributes?: TraceAttributes): void
  setAttribute(key: string, value: string | number | boolean): void
}

export interface Tracer {
  startSpan(name: string, attributes?: TraceAttributes): Span
}

export class NoopTracer implements Tracer {
  startSpan(_name: string, _attributes?: TraceAttributes): Span {
    return {
      end: () => {},
      setAttribute: () => {}
    }
  }
}

export class TracerProvider {
  private static instance: Tracer

  static getTracer(): Tracer {
    return this.instance ?? new NoopTracer()
  }

  static setTracer(tracer: Tracer) {
    this.instance = tracer
  }
}