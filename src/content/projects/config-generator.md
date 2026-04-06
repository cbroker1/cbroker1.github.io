---
title: "Config Generator"
description: "CLI tool for generating and validating infrastructure configuration files."
date: 2025-11-20
tags: ["Go", "CLI", "DevOps"]
github: "https://github.com/cbroker1/config-generator"
featured: false
status: "complete"
---

## Problem

Infrastructure teams were hand-editing YAML configuration files across dozens of services, leading to inconsistencies and deployment failures from typos and schema drift.

## Approach

Built a Go CLI that reads a declarative spec and generates validated configuration files for multiple target formats (Docker Compose, Kubernetes manifests, Terraform).

- Go for fast single-binary distribution
- JSON Schema validation at generation time
- Template-based output with override support
- Dry-run mode with diff output

## Outcome

Eliminated configuration-related deployment failures for the team. The tool generates configs for 40+ services from a single source of truth.
