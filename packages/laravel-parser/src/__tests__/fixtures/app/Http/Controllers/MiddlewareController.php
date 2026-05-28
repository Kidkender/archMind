<?php

namespace App\Http\Controllers;

class MiddlewareController extends Controller
{
    public function __construct()
    {
        parent::__construct();
        $this->middleware('auth:web,subdealer', ['except' => ['publicAction', 'anotherPublic']]);
        $this->middleware('verified');
    }

    public function protectedAction()
    {
        return 'protected';
    }

    public function publicAction()
    {
        return 'public';
    }

    public function anotherPublic()
    {
        return 'also public';
    }
}
