/**
 * Authorization precision on real-app patterns (research/laravel-scan):
 * each case here was a false positive on BookStack, monica, invoiceninja or koel
 * before 0.11. The graph must carry an authorization fact for each of them —
 * and must not invent resources or missing policies.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join, dirname } from "path"
import { augmentGraph, isRealAuthorizeBody } from "../graph-augmenter.js"
import { middlewareToNode } from "../middleware-mapper.js"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

let root: string

function put(rel: string, body: string): void {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body)
}

function graphFor(method: string, path: string, controller: string, action: string): IntermediateExecutionGraph {
  return {
    entrypoint: `${method} ${path}`,
    method,
    path,
    nodes: [
      { id: "mw_auth", type: "ir:auth_gate", symbol: "auth:sanctum", role: "authentication" },
      {
        id:     `ctrl_${controller.toLowerCase()}_${action}`,
        type:   "ir:business_handler",
        symbol: `${controller}::${action}`,
        role:   "handler",
        file:   `app/Http/Controllers/${controller}.php`,
      },
    ],
    edges:       [{ from: "mw_auth", to: `ctrl_${controller.toLowerCase()}_${action}`, relation: "ir:precedes", traceability: "static" }],
    annotations: [],
  }
}

const authz = (g: IntermediateExecutionGraph) => g.nodes.filter((n) => n.type === "ir:authz_check")

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "archmind-authz-"))

  put("app/Models/Page.php", `<?php
namespace App\\Models;
use Illuminate\\Database\\Eloquent\\Model;
class Page extends Model {}
`)
  put("app/Models/Song.php", `<?php
namespace App\\Models;
use Illuminate\\Database\\Eloquent\\Model;
class Song extends Model {}
`)
  put("app/Search/SearchResultsFormatter.php", `<?php
namespace App\\Search;
class SearchResultsFormatter {}
`)
  // Policy lives in a domain sub-folder, not app/Policies/SongPolicy.php directly
  put("app/Policies/Media/SongPolicy.php", `<?php
namespace App\\Policies\\Media;
class SongPolicy {}
`)

  // BookStack: controller-level permission helpers, no policy
  put("app/Http/Controllers/PageApiController.php", `<?php
namespace App\\Http\\Controllers;
use App\\Models\\Page;
use App\\Search\\SearchResultsFormatter;
class PageApiController extends Controller {
  public function update(Page $page) {
    $this->checkOwnablePermission('page-update', $page);
    $page->save();
  }
  public function delete(string $id) {
    if (!userCan('page-delete')) { abort(403); }
  }
  public function search(SearchResultsFormatter $formatter) {
    return $formatter;
  }
  public function publish(Page $page) {
    abort_unless(request()->user()->can('publish', $page), 403);
  }
}
`)

  // koel: Laravel resolves the policy from the model, not the controller name
  put("app/Http/Controllers/ScrobbleController.php", `<?php
namespace App\\Http\\Controllers;
use App\\Models\\Song;
class ScrobbleController extends Controller {
  public function __invoke(Song $song) {
    $this->authorize('access', $song);
  }
  public function missing(Page $page) {
    $this->authorize('view', $page);
  }
}
`)

  // authorizeResource() in the constructor
  put("app/Http/Controllers/SongController.php", `<?php
namespace App\\Http\\Controllers;
use App\\Models\\Song;
class SongController extends Controller {
  public function __construct() { $this->authorizeResource(Song::class, 'song', ['except' => ['index']]); }
  public function update(Song $song) { $song->save(); }
  public function index() { return Song::all(); }
}
`)

  // monica: (new UpdateVault)->execute() with permissions() rules in the service
  put("app/Services/UpdateVault.php", `<?php
namespace App\\Services;
class UpdateVault extends BaseService {
  public function permissions(): array
  {
    return [
      'author_must_belong_to_account',
      'author_must_be_vault_manager',
    ];
  }
  public function execute(array $data) { $this->validateRules($data); }
}
`)
  put("app/Http/Controllers/VaultController.php", `<?php
namespace App\\Http\\Controllers;
use App\\Services\\UpdateVault;
class VaultController extends Controller {
  public function update(Request $request, string $vaultId) {
    $vault = (new UpdateVault)->execute(['vault_id' => $vaultId]);
    return $vault;
  }
}
`)

  // invoiceninja: authorization in FormRequest::authorize()
  put("app/Http/Requests/UpdateClientRequest.php", `<?php
namespace App\\Http\\Requests;
class UpdateClientRequest extends Request {
  public function authorize(): bool { return auth()->user()->can('edit', $this->client); }
  public function rules() { return []; }
}
`)
  put("app/Http/Requests/StoreNoteRequest.php", `<?php
namespace App\\Http\\Requests;
class StoreNoteRequest extends Request {
  public function authorize(): bool { return auth()->check(); }
}
`)
  put("app/Http/Controllers/ClientController.php", `<?php
namespace App\\Http\\Controllers;
use App\\Http\\Requests\\UpdateClientRequest;
use App\\Http\\Requests\\StoreNoteRequest;
class ClientController extends Controller {
  public function update(UpdateClientRequest $request) { return 1; }
  public function note(StoreNoteRequest $request) { return 1; }
}
`)

  // Laravel 11 style constructor middleware: enum → 'can:…', chained ->only()
  put("app/Http/Controllers/WebhookController.php", `<?php
namespace App\Http\Controllers;
class WebhookController extends Controller {
  public function __construct() {
    $this->middleware([Permission::SettingsManage->middleware()]);
    $this->middleware('can:export')->only(['export']);
  }
  public function update(Request $request, string $id) { return 1; }
  public function export() { return 1; }
}
`)

  // koel: apiResource on a controller that only implements index()
  put("app/Http/Controllers/ArtistSongController.php", `<?php
namespace App\Http\Controllers;
class ArtistSongController extends Controller {
  public function index() { return []; }
}
`)
  put("app/Http/Controllers/CrudController.php", `<?php
namespace App\Http\Controllers;
class CrudController extends BaseCrudController {
  public function index() { return []; }
}
`)

  // same-namespace helper type (no use import) — BookStack SearchController
  put("app/Search/SearchController.php", `<?php
namespace App\Search;
class SearchController {
  public function search(SearchResultsFormatter $formatter) { return 1; }
}
`)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("controller-level permission helpers (BookStack)", () => {
  test("$this->checkOwnablePermission() is an authorization fact", () => {
    const g = augmentGraph(graphFor("PUT", "/api/pages/{page}", "PageApiController", "update"), { projectRoot: root })
    expect(authz(g).map((n) => n.symbol)).toContain("checkOwnablePermission(page-update)")
    // wired to the bound model, so resource_unprotected has nothing to report
    const res = g.nodes.find((n) => n.type === "ir:resource")
    expect(res?.symbol).toBe("Page")
    expect(g.edges.some((e) => e.relation === "ir:authorizes" && e.to === res!.id)).toBe(true)
    expect(g.annotations.some((a) => a.type === "missing_policy")).toBe(false)
  })

  test("global userCan() helper is an authorization fact", () => {
    const g = augmentGraph(graphFor("DELETE", "/api/pages/{id}", "PageApiController", "delete"), { projectRoot: root })
    expect(authz(g).map((n) => n.symbol)).toContain("userCan(page-delete)")
  })

  test("$user->can() inside abort_unless is an authorization fact", () => {
    const g = augmentGraph(graphFor("POST", "/api/pages/{page}/publish", "PageApiController", "publish"), { projectRoot: root })
    expect(authz(g).map((n) => n.symbol)).toContain("can(publish)")
  })

  test("a typed helper param that is not an Eloquent model is not a resource", () => {
    const g = augmentGraph(graphFor("GET", "/search", "PageApiController", "search"), { projectRoot: root })
    expect(g.nodes.some((n) => n.type === "ir:resource")).toBe(false)
  })
})

describe("policy resolution by model (koel)", () => {
  test("authorize('access', $song) resolves SongPolicy, found in a sub-folder — no missing_policy", () => {
    const g = augmentGraph(graphFor("POST", "/api/songs/{song}/scrobble", "ScrobbleController", "__invoke"), { projectRoot: root })
    expect(authz(g).map((n) => n.symbol)).toContain("SongPolicy::access")
    expect(g.annotations.some((a) => a.type === "missing_policy")).toBe(false)
  })

  test("authorize() on a model whose policy really doesn't exist still raises missing_policy", () => {
    const g = augmentGraph(graphFor("GET", "/pages/{page}", "ScrobbleController", "missing"), { projectRoot: root })
    const missing = g.annotations.filter((a) => a.type === "missing_policy")
    expect(missing).toHaveLength(1)
    expect(missing[0]!.description).toContain("PagePolicy")
  })

  test("authorizeResource() in the constructor authorizes resource methods, honouring except", () => {
    const upd = augmentGraph(graphFor("PUT", "/songs/{song}", "SongController", "update"), { projectRoot: root })
    expect(authz(upd).map((n) => n.symbol)).toContain("SongPolicy::update")
    const idx = augmentGraph(graphFor("GET", "/songs", "SongController", "index"), { projectRoot: root })
    expect(authz(idx)).toHaveLength(0)
  })
})

describe("service-layer authorization (monica)", () => {
  test("(new UpdateVault)->execute() is a service call whose permissions() rules are an authz fact", () => {
    const g = augmentGraph(graphFor("PUT", "/api/vaults/{id}", "VaultController", "update"), { projectRoot: root })
    expect(g.nodes.some((n) => n.type === "ir:service_call" && n.symbol === "UpdateVault::execute")).toBe(true)
    const check = authz(g).find((n) => n.symbol === "UpdateVault::permissions")
    expect(check?.args).toEqual(["author_must_belong_to_account", "author_must_be_vault_manager"])
  })
})

describe("FormRequest::authorize() (invoiceninja)", () => {
  test("a real check in authorize() is an authorization fact", () => {
    const g = augmentGraph(graphFor("PUT", "/api/v1/clients/{id}", "ClientController", "update"), { projectRoot: root })
    expect(authz(g).map((n) => n.symbol)).toContain("UpdateClientRequest::authorize")
  })

  test("authorize() that only checks login is not", () => {
    const g = augmentGraph(graphFor("POST", "/api/v1/notes", "ClientController", "note"), { projectRoot: root })
    expect(authz(g)).toHaveLength(0)
  })

  test.each([
    ["true", false],
    ["false", false],
    ["auth()->check()", false],
    ["$this->user() !== null", false],
    ["auth()->user()->can('edit', $this->client)", true],
    ["$this->user()->isAdmin()", true],
    ["if ($this->user()->cannot('x')) { return false; } return true;", true],
  ])("isRealAuthorizeBody(%s) = %s", (body, expected) => {
    expect(isRealAuthorizeBody(body)).toBe(expected)
  })
})

describe("middleware classification", () => {
  test.each([
    ["SessionDomains", "ir:unknown_middleware"],
    ["App\\Http\\Middleware\\SetLocale", "ir:unknown_middleware"],
    ["TokenAuth", "ir:auth_gate"],
    ["App\\Http\\Middleware\\Authenticate", "ir:auth_gate"],
    ["AuthorizeAdmin", "ir:authz_check"],
    ["CheckRole", "ir:authz_check"],
  ])("%s → %s", (raw, type) => {
    expect(middlewareToNode(raw, 0).type).toBe(type)
  })
})

describe("constructor middleware (BookStack WebhookController)", () => {
  test("enum ->middleware() in a middleware array is an authorization check", () => {
    const g = augmentGraph(graphFor("PUT", "/settings/webhooks/{id}", "WebhookController", "update"), { projectRoot: root })
    expect(authz(g).length).toBeGreaterThan(0)
  })
  test("->only([...]) chained on $this->middleware() limits it to those methods", () => {
    const upd = augmentGraph(graphFor("PUT", "/settings/webhooks/{id}", "WebhookController", "update"), { projectRoot: root })
    expect(upd.nodes.some((n) => n.symbol === "can:export")).toBe(false)
    const exp = augmentGraph(graphFor("GET", "/settings/webhooks/export", "WebhookController", "export"), { projectRoot: root })
    expect(exp.nodes.some((n) => n.symbol === "can:export" && n.type === "ir:authz_check")).toBe(true)
  })
})

describe("routes to actions the controller doesn't define", () => {
  test("flagged when the controller can't inherit the method", () => {
    const g = augmentGraph(graphFor("PUT", "/artists/{artist}/songs/{id}", "ArtistSongController", "update"), { projectRoot: root })
    expect(g.annotations.some((a) => a.type === "handler_not_found")).toBe(true)
  })
  test("not flagged when a base class may provide it", () => {
    const g = augmentGraph(graphFor("PUT", "/things/{id}", "CrudController", "update"), { projectRoot: root })
    expect(g.annotations.some((a) => a.type === "handler_not_found")).toBe(false)
  })
})

describe("same-namespace typed params", () => {
  test("a class next to the controller that isn't a model is not a resource", () => {
    const g: IntermediateExecutionGraph = {
      ...graphFor("GET", "/search", "SearchController", "search"),
    }
    g.nodes[1] = { ...g.nodes[1]!, file: "app/Search/SearchController.php" }
    const out = augmentGraph(g, { projectRoot: root })
    expect(out.nodes.some((n) => n.type === "ir:resource")).toBe(false)
  })
})

describe("built-in middleware aliases without a Kernel (Laravel 11+)", () => {
  test.each([
    ["auth", "ir:auth_gate"],
    ["can:update,post", "ir:authz_check"],
    ["role:admin", "ir:authz_check"],
    ["guest", "ir:unknown_middleware"],
    ["App\Http\Middleware\RedirectIfAuthenticated", "ir:unknown_middleware"],
  ])("%s → %s", (raw, type) => {
    expect(middlewareToNode(raw, 0).type).toBe(type)
  })
})

describe("signed URLs", () => {
  test.each([
    ["signed", "signature_check"],
    ["signed:relative", "signature_check"],
    ["App\Http\Middleware\ValidateSignature", "signature_check"],
  ])("%s → %s", (raw, type) => {
    expect(middlewareToNode(raw, 0).type).toBe(type)
  })
})

import { parseApiResource } from "../resource-parser.js"

describe("sensitive fields in API resources (koel UserResource)", () => {
  test("conditional ($this->when) fields and boolean flags are not sensitive; plain secrets are", () => {
    put("app/Http/Resources/UserResource.php", `<?php
namespace App\Http\Resources;
class UserResource extends JsonResource {
  public function toArray($request) {
    return [
      'name' => $this->name,
      'subsonic_api_key' => $this->when($isCurrentUser, fn () => $this->subsonic_api_key),
      'has_password' => (bool) $this->password,
      'is_admin' => $this->is_admin,
      'api_token' => $this->api_token,
    ];
  }
}
`)
    const info = parseApiResource(join(root, "app/Http/Resources/UserResource.php"))!
    const sensitive = info.fields.filter((f) => f.isSensitive).map((f) => f.key)
    expect(sensitive).toEqual(["api_token"])
  })
})

describe("writes and reads scoped to the caller", () => {
  beforeAll(() => {
    put("app/Repositories/AlbumRepository.php", `<?php
namespace App\\Repositories;
class AlbumRepository {
  public function getOne($id) {
    return Album::query()->withUserContext(user: $this->auth->user())->findOrFail($id);
  }
  public function getRaw($id) { return Album::query()->findOrFail($id); }
}
`)
    put("app/Http/Controllers/AlbumController.php", `<?php
namespace App\\Http\\Controllers;
use App\\Models\\Song;
use App\\Repositories\\AlbumRepository;
class AlbumController extends Controller {
  public function __construct(private AlbumRepository $repository) {}
  public function show(Song $song) { return $this->repository->getOne($song->id); }
  public function raw(Song $song) { return $this->repository->getRaw($song->id); }
}
`)
    put("app/Http/Controllers/UserTokenController.php", `<?php
namespace App\\Http\\Controllers;
class UserTokenController extends Controller {
  public function destroy(Request $request, string $driver) {
    $request->user()->userTokens()->where('driver', $driver)->delete();
  }
  public function company(Request $request) {
    $request->user()->company()->update(['name' => 'x']);
  }
}
`)
  })

  test("repository re-fetch through accessible()/withUserContext() is an authorization fact (koel)", () => {
    const g = augmentGraph(graphFor("GET", "/api/albums/{song}", "AlbumController", "show"), { projectRoot: root })
    expect(authz(g).map((n) => n.symbol)).toContain("AlbumRepository::getOne (query scoped to caller)")
    const raw = augmentGraph(graphFor("GET", "/api/albums/{song}/raw", "AlbumController", "raw"), { projectRoot: root })
    expect(authz(raw)).toHaveLength(0)
  })

  test("deleting through the caller's own relation is scoped; through company() is not (monica)", () => {
    const own = augmentGraph(graphFor("DELETE", "/auth/{driver}", "UserTokenController", "destroy"), { projectRoot: root })
    expect(authz(own).map((n) => n.symbol)).toContain("scoped to caller(userTokens()->delete)")
    const shared = augmentGraph(graphFor("POST", "/company", "UserTokenController", "company"), { projectRoot: root })
    expect(authz(shared)).toHaveLength(0)
  })
})


describe("route-bound model the handler never uses (invoiceninja ProfileController::edit)", () => {
  test("is not a resource the route exposes", () => {
    put("app/Http/Controllers/ProfileController.php", [
      "<?php",
      "namespace App\\Http\\Controllers;",
      "use App\\Models\\Page;",
      "class ProfileController extends Controller {",
      "  public function edit(Page $page) { return view('profile.index'); }",
      "}",
    ].join("\n"))
    const g = augmentGraph(graphFor("GET", "/profile/{page}/edit", "ProfileController", "edit"), { projectRoot: root })
    expect(g.nodes.some((n) => n.type === "ir:resource")).toBe(false)
  })
})

describe("policy on an interface-typed param (koel Authenticatable $invitor)", () => {
  test("no missing_policy — Laravel resolves the policy from the runtime class", () => {
    put("app/Http/Controllers/InviteController.php", [
      "<?php",
      "namespace App\\Http\\Controllers;",
      "use Illuminate\\Contracts\\Auth\\Authenticatable;",
      "class InviteController extends Controller {",
      "  public function invite(Authenticatable $invitor) { $this->authorize('manage', $invitor); }",
      "}",
    ].join("\n"))
    const g = augmentGraph(graphFor("POST", "/api/invitations", "InviteController", "invite"), { projectRoot: root })
    expect(g.annotations.some((a) => a.type === "missing_policy")).toBe(false)
  })
})

describe("queries filtered on the caller (invoiceninja client portal)", () => {
  test("whereClientId(<caller>) scopes the route; where('company_id', <caller>) does not", () => {
    put("app/Http/Controllers/PortalController.php", [
      "<?php",
      "namespace App\\Http\\Controllers;",
      "class PortalController extends Controller {",
      "  public function download(Request $request) { return $this->pdf($request->ids); }",
      "  private function pdf($ids) {",
      "    return Invoice::query()->whereIn('id', $ids)->whereClientId(auth()->guard('contact')->user()->client_id)->get();",
      "  }",
      "  public function multiple(Request $request) {",
      "    return Document::query()->whereIn('id', $request->ids)->where('company_id', auth()->guard('contact')->user()->company_id)->get();",
      "  }",
      "}",
    ].join("\n"))
    const own = augmentGraph(graphFor("POST", "/client/invoices/download", "PortalController", "download"), { projectRoot: root })
    expect(authz(own).map((n) => n.symbol)).toContain("query scoped to caller(client_id)")
    const shared = augmentGraph(graphFor("POST", "/client/documents/download_multiple", "PortalController", "multiple"), { projectRoot: root })
    expect(authz(shared)).toHaveLength(0)
  })
})

describe("FormRequest authorize() with a conditional deny (invoiceninja DownloadMultipleDocumentsRequest)", () => {
  test("a loop that returns false per item is a real check; `if (!auth()->check()) return false; return true;` is not", () => {
    put("app/Http/Requests/DownloadRequest.php", [
      "<?php",
      "namespace App\\Http\\Requests;",
      "class DownloadRequest extends Request {",
      "  public function authorize(): bool {",
      "    foreach ($docs as $d) { if (! $this->contactCanAccessDocument($c, $d)) { return false; } }",
      "    return true;",
      "  }",
      "}",
    ].join("\n"))
    put("app/Http/Requests/LoggedInRequest.php", [
      "<?php",
      "namespace App\\Http\\Requests;",
      "class LoggedInRequest extends Request {",
      "  public function authorize(): bool {",
      "    if (!auth()->check()) { return false; }",
      "    return true;",
      "  }",
      "}",
    ].join("\n"))
    put("app/Http/Controllers/DocController.php", [
      "<?php",
      "namespace App\\Http\\Controllers;",
      "use App\\Http\\Requests\\DownloadRequest;",
      "use App\\Http\\Requests\\LoggedInRequest;",
      "class DocController extends Controller {",
      "  public function many(DownloadRequest $request) { return 1; }",
      "  public function mine(LoggedInRequest $request) { return 1; }",
      "}",
    ].join("\n"))
    const many = augmentGraph(graphFor("POST", "/docs/download", "DocController", "many"), { projectRoot: root })
    expect(authz(many).map((n) => n.symbol)).toContain("DownloadRequest::authorize")
    const mine = augmentGraph(graphFor("POST", "/docs/mine", "DocController", "mine"), { projectRoot: root })
    expect(authz(mine)).toHaveLength(0)
  })
})
