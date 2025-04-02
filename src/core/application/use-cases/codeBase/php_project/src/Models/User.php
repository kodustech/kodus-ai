<?php

namespace App\Models;

// Include de arquivo
require_once __DIR__ . '/../helpers.php';

// Import de trait
use App\Traits\Timestampable;

// Import de interface
use App\Contracts\Model;

class User implements Model
{
    use Timestampable;

    private string $name;
    private string $email;

    public function __construct(string $name, string $email)
    {
        $this->name = $name;
        $this->email = $email;
    }

    public static function find($id)
    {
        // Implementation
    }
}
