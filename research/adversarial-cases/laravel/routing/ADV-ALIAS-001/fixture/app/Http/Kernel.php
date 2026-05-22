<?php

namespace App\Http;

use Illuminate\Foundation\Http\Kernel as HttpKernel;

class Kernel extends HttpKernel
{
    protected $middlewareAliases = [
        'auth'       => \App\Http\Middleware\Authenticate::class,
        'role'       => \App\Http\Middleware\EnsureUserHasRole::class,
        'tenant'     => \App\Http\Middleware\ResolveTenant::class,
        'verified'   => \Illuminate\Auth\Middleware\EnsureEmailIsVerified::class,
    ];
}
