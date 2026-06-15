<?php

namespace App\Providers;

use Illuminate\Support\ServiceProvider;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Event;
use Illuminate\Queue\Events\JobProcessing;
use Illuminate\Queue\Events\JobProcessed;
use Illuminate\Queue\Events\JobFailed;
use OpenTelemetry\API\Globals;
use OpenTelemetry\API\Trace\SpanKind;
use OpenTelemetry\API\Trace\StatusCode;
use OpenTelemetry\Contrib\Otlp\OtlpHttpTransportFactory;
use OpenTelemetry\Contrib\Otlp\SpanExporter;
use OpenTelemetry\SDK\Trace\SpanProcessor\SimpleSpanProcessor;
use OpenTelemetry\SDK\Trace\TracerProvider;
use OpenTelemetry\SDK\Common\Attribute\Attributes;
use OpenTelemetry\SDK\Resource\ResourceInfo;
use OpenTelemetry\SemConv\ResourceAttributes;

/**
 * ArchMind OTLP instrumentation provider.
 * Instruments: HTTP requests, Queue Jobs, Event dispatches, Policies.
 *
 * Setup:
 *   1. Copy this file to app/Providers/ArchMindOtelServiceProvider.php
 *   2. Register in bootstrap/providers.php or config/app.php providers array
 *   3. Set env vars (see .env.otel.example)
 *   4. Run: php artisan serve (with OTLP collector running on :4318)
 */
class ArchMindOtelServiceProvider extends ServiceProvider
{
    private ?\OpenTelemetry\API\Trace\TracerInterface $tracer = null;

    public function register(): void
    {
        if (! env('OTEL_ENABLED', false)) {
            return;
        }

        $resource = ResourceInfo::create(Attributes::create([
            ResourceAttributes::SERVICE_NAME    => env('OTEL_SERVICE_NAME', config('app.name', 'laravel')),
            ResourceAttributes::SERVICE_VERSION => '1.0.0',
        ]));

        $transport = (new OtlpHttpTransportFactory())->create(
            env('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4318') . '/v1/traces',
            'application/json',
        );

        $exporter      = new SpanExporter($transport);
        $processor     = new SimpleSpanProcessor($exporter);
        $tracerProvider = new TracerProvider([$processor], null, $resource);

        $this->tracer = $tracerProvider->getTracer('archmind');

        $this->app->instance('archmind.tracer', $this->tracer);
    }

    public function boot(): void
    {
        if (! env('OTEL_ENABLED', false) || ! $this->tracer) {
            return;
        }

        $this->instrumentQueueJobs();
        $this->instrumentHttpMiddleware();
    }

    private function instrumentQueueJobs(): void
    {
        $tracer = $this->tracer;

        Queue::before(function (JobProcessing $event) use ($tracer) {
            $jobName = $event->job->resolveName();
            $span = $tracer->spanBuilder($jobName)
                ->setSpanKind(SpanKind::KIND_CONSUMER)
                ->setAttribute('code.namespace', $jobName)
                ->setAttribute('code.function', 'handle')
                ->setAttribute('queue.job.name', $jobName)
                ->setAttribute('queue.name', $event->job->getQueue())
                ->startSpan();

            // Store in a static registry keyed by connection+job-id so after() can end it
            SpanRegistry::set($event->connectionName . ':' . $event->job->getJobId(), $span);
        });

        Queue::after(function (JobProcessed $event) use ($tracer) {
            $key = $event->connectionName . ':' . $event->job->getJobId();
            $span = SpanRegistry::pop($key);
            $span?->end();
        });

        Queue::failing(function (JobFailed $event) use ($tracer) {
            $key = $event->connectionName . ':' . $event->job->getJobId();
            $span = SpanRegistry::pop($key);
            if ($span) {
                $span->setStatus(StatusCode::STATUS_ERROR, $event->exception->getMessage());
                $span->end();
            }
        });
    }

    private function instrumentHttpMiddleware(): void
    {
        // HTTP spans are emitted via a middleware — see ArchMindOtelMiddleware.php
        // Register here if needed for older Laravel versions without automatic discovery.
    }
}

/**
 * Minimal static span registry to bridge Queue::before → Queue::after.
 * Not thread-safe, fine for single-process queue workers.
 */
class SpanRegistry
{
    private static array $spans = [];

    public static function set(string $key, \OpenTelemetry\API\Trace\SpanInterface $span): void
    {
        static::$spans[$key] = $span;
    }

    public static function pop(string $key): ?\OpenTelemetry\API\Trace\SpanInterface
    {
        $span = static::$spans[$key] ?? null;
        unset(static::$spans[$key]);
        return $span;
    }
}
