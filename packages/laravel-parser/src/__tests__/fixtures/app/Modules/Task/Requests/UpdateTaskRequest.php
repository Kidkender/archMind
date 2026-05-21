<?php

namespace App\Modules\Task\Requests;

use Illuminate\Foundation\Http\FormRequest;

class UpdateTaskRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'title'       => ['sometimes', 'required', 'string', 'max:255'],
            'description' => ['sometimes', 'nullable', 'string', 'max:5000'],
            'status'      => ['sometimes', 'required', 'string', 'in:pending,in_progress,done'],
            'due_date'    => ['sometimes', 'nullable', 'date'],
            'assignee_id' => ['sometimes', 'nullable', 'integer', 'exists:users,id'],
        ];
    }
}
