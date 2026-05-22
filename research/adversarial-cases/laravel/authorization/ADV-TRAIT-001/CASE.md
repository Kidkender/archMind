# ADV-TRAIT-001: Trait-Injected Controller Authorization

## Summary

A controller uses a trait `AuthorizesRequests` (Laravel's built-in) but also
mixes in a custom trait `HasProjectScope` that overrides `authorize()` to add
project-level ownership check before delegating to the policy.

```php
class ProjectController extends Controller
{
    use HasProjectScope;  // overrides authorize() — adds ownership gate

    public function update(UpdateProjectRequest $request, Project $project)
    {
        $this->authorize('update', $project);  // goes through trait, not direct
        // ...
    }
}
```

The engine sees `$this->authorize('update', $project)` and emits a direct
`policy_check` edge to `ProjectPolicy::update`. The `HasProjectScope::authorize()`
interception is invisible.

## Why This Is Adversarial

- `HasProjectScope::authorize()` checks `$project->owner_id === auth()->id()`
  before calling `parent::authorize()`
- This is a semantic authorization gate that appears nowhere in the static call graph
- Engine misses an ownership_check node entirely
- Recall on HIGH nodes drops significantly

## Fixture

`fixture/app/Http/Controllers/ProjectController.php`
`fixture/app/Traits/HasProjectScope.php`
`fixture/app/Policies/ProjectPolicy.php`

## Expected Behavior

Engine should detect trait method override on `authorize()` and emit an
intermediate `authorization_check` node before the policy edge.

## Failure Mode

`unresolved_trait_dispatch` — trait interception invisible, ownership gate
missing from graph. Expected failure: acceptable at current extraction ceiling.
