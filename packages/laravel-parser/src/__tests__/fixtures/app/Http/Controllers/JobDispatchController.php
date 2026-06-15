<?php

namespace App\Http\Controllers;

use App\Jobs\ProcessPaymentJob;
use App\Jobs\SendInvoiceJob;
use App\Events\OrderCreated;
use App\Http\Requests\StoreOrderRequest;
use App\Models\Order;
use Illuminate\Http\JsonResponse;

class JobDispatchController
{
    /**
     * QUEUE-JOB-001: Job and event dispatches outside DB::transaction().
     */
    public function store(StoreOrderRequest $request): JsonResponse
    {
        $order = Order::create($request->validated());

        // Static dispatch — should emit ir:queue_job
        ProcessPaymentJob::dispatch($order);

        // Global helper — should emit ir:queue_job
        dispatch(new SendInvoiceJob($order->id));

        // Event dispatch outside transaction — should emit ir:event_dispatch
        OrderCreated::dispatch($order);

        return response()->json($order, 201);
    }
}
