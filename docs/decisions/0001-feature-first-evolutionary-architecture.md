# Adopt feature-first evolutionary architecture

## Status

Accepted

## Context and Problem Statement

Completed feature work accumulated in large entry files and relies on documented rather than executable dependency boundaries. AI-assisted changes need smaller coherent context and mechanically checked direction.

## Considered Options

- Feature-first Web plus bounded-context runtime packages.
- Strict Clean Architecture in every app and package.
- Continue technical-type folders and documentation-only boundaries.

## Decision Outcome

Use feature-first vertical slices in Web and domain/application/adapters inside large runtime packages. Enforce cross-package direction with static dependency checks. This preserves the existing product boundaries without adding ceremonial layers to small modules.

## Consequences

- Related UI, state, API adapters, and tests stay close together.
- Runtime packages expose smaller public surfaces.
- Moving files requires consumer and documentation updates in the same task.
