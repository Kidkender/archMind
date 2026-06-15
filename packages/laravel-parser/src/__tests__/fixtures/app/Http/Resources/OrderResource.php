<?php

namespace App\Http\Resources;

use Illuminate\Http\Resources\Json\JsonResource;

class OrderResource extends JsonResource
{
    public function toArray($request): array
    {
        return [
            'id'         => $this->id,
            'status'     => $this->status,
            'total'      => $this->total,
            'created_at' => $this->created_at,
            'token'      => $this->when($this->isAdmin(), $this->api_token),
        ];
    }
}
