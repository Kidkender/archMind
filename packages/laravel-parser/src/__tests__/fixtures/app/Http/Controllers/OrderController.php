<?php

namespace App\Http\Controllers;

use App\Http\Resources\OrderResource;
use App\Models\Order;
use App\Http\Requests\StoreOrderRequest;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class OrderController
{
    /**
     * API-RESOURCE-001: single resource return.
     */
    public function show(Order $order): JsonResource
    {
        $this->authorize('view', $order);
        return new OrderResource($order);
    }

    /**
     * API-RESOURCE-001: collection return via static method.
     */
    public function index(): JsonResource
    {
        $orders = Order::all();
        return OrderResource::collection($orders);
    }

    /**
     * API-RESOURCE-001: resource returned after create.
     */
    public function store(StoreOrderRequest $request): JsonResource
    {
        $order = Order::create($request->validated());
        return new OrderResource($order);
    }
}
