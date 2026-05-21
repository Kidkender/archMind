<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use App\Modules\Tenant\Models\Tenant;
use App\Modules\Tenant\Services\TenantResolver;
use Symfony\Component\HttpFoundation\Response;

class ResolveTenant
{
    public function __construct(private TenantResolver $resolver) {}

    public function handle(Request $request, Closure $next): Response
    {
        $subdomain = $request->getHost();
        $tenant    = $this->resolver->resolveBySubdomain($subdomain);

        if (! $tenant) {
            abort(404, 'Tenant not found.');
        }

        app()->instance('tenant', $tenant);

        return $next($request);
    }
}
