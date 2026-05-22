<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class ResolveTenant
{
    public function handle(Request $request, Closure $next): Response
    {
        $subdomain = explode('.', $request->getHost())[0];
        $tenant = \App\Models\Tenant::where('slug', $subdomain)->firstOrFail();
        app()->instance('tenant', $tenant);

        return $next($request);
    }
}
