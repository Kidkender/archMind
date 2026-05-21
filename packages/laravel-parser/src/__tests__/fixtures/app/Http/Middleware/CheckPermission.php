<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use App\Modules\Access\Services\PermissionService;
use Symfony\Component\HttpFoundation\Response;

class CheckPermission
{
    public function __construct(private PermissionService $permissionService) {}

    public function handle(Request $request, Closure $next, string $permission): Response
    {
        $tenant = app('tenant');
        $user   = $request->user();

        if (! $user) {
            abort(401, 'Unauthenticated.');
        }

        if (! $this->permissionService->hasPermission($user, $tenant, $permission)) {
            abort(403, 'Forbidden.');
        }

        return $next($request);
    }
}
