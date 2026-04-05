---
title: "AI Yard Optimizer"
description: "Computer vision system for real-time yard management and vehicle tracking."
date: 2026-03-01
tags: ["AI", "Computer Vision", "Python"]
image: "/images/projects/ai-yard-optimizer.png"
github: "https://github.com/cbroker1/ai-yard-optimizer"
featured: true
status: "complete"
---

## Problem

Large distribution yards struggle with real-time visibility into vehicle locations and dock availability. Manual tracking leads to bottlenecks, wasted time, and missed appointments.

## Approach

Built a computer vision pipeline using YOLO for vehicle detection and a custom tracking algorithm for persistent identification across camera feeds. The system integrates with existing warehouse management software through a REST API.

Key technical decisions:
- YOLO v8 for detection — best balance of speed and accuracy for this use case
- Custom re-identification model trained on yard-specific vehicle features
- Event-driven architecture for real-time updates
- PostgreSQL with PostGIS for spatial queries

## Outcome

Reduced average vehicle dwell time by 35% in pilot deployment. The system processes 12 camera feeds simultaneously on a single GPU node with sub-second latency.
