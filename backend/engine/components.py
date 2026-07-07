"""
Core DES components — adapted from Simul8_app_rep/simulation/components.py.
Generator, Queue, Activity, Exit, SimulationStats, Entity.
No framework dependencies.
"""
import simpy
import random
from typing import Dict, List, Optional, Any
from dataclasses import dataclass, field
from enum import Enum


class ComponentType(Enum):
    GENERATOR = "generator"
    QUEUE = "queue"
    ACTIVITY = "activity"
    RESOURCE = "resource"
    EXIT = "exit"


@dataclass
class SimulationStats:
    """Collects aggregate statistics during a simulation run."""
    total_entities: int = 0
    completed_entities: int = 0
    total_wait_time: float = 0.0
    total_processing_time: float = 0.0
    avg_wait_time: float = 0.0
    avg_processing_time: float = 0.0
    throughput: float = 0.0
    resource_utilization: Dict[str, float] = field(default_factory=dict)
    queue_lengths: Dict[str, List[int]] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "total_entities": self.total_entities,
            "completed_entities": self.completed_entities,
            "avg_wait_time": round(self.avg_wait_time, 4),
            "avg_processing_time": round(self.avg_processing_time, 4),
            "throughput": round(self.throughput, 4),
            "resource_utilization": self.resource_utilization,
        }


class Entity:
    """An entity (job/part) flowing through the simulation."""

    def __init__(self, entity_id: int, creation_time: float):
        self.id = entity_id
        self.creation_time = creation_time
        self.start_times: Dict[str, float] = {}
        self.end_times: Dict[str, float] = {}
        self.wait_times: Dict[str, float] = {}
        self.attributes: Dict[str, Any] = {}


class Generator:
    """Generates entities at exponential inter-arrival intervals."""

    def __init__(
        self,
        name: str,
        env: simpy.Environment,
        inter_arrival_time: float,
        total_entities: Optional[int] = None,
    ):
        self.name = name
        self.env = env
        self.inter_arrival_time = inter_arrival_time
        self.total_entities = total_entities
        self.entity_count = 0
        self.next_components: List[Any] = []

    def process(self, stats: SimulationStats):
        while True:
            if self.total_entities and self.entity_count >= self.total_entities:
                break

            entity = Entity(self.entity_count, self.env.now)
            self.entity_count += 1
            stats.total_entities += 1

            for component in self.next_components:
                self.env.process(component.process(entity, stats))

            yield self.env.timeout(random.expovariate(1.0 / self.inter_arrival_time))


class Queue:
    """Passive queue — holds entities before they enter an activity."""

    def __init__(self, name: str, capacity: int = float("inf")):
        self.name = name
        self.capacity = capacity
        self.next_components: List[Any] = []

    def process(self, entity: Entity, stats: SimulationStats):
        entity.start_times[self.name] = entity.creation_time
        for component in self.next_components:
            yield from component.process(entity, stats)


class Activity:
    """Processing activity with configurable processing time distribution."""

    def __init__(
        self,
        name: str,
        env: simpy.Environment,
        processing_time: float,
        resource_name: Optional[str] = None,
    ):
        self.name = name
        self.env = env
        self.processing_time = processing_time
        self.resource_name = resource_name
        self.next_components: List[Any] = []

    def process(self, entity: Entity, stats: SimulationStats):
        start_time = self.env.now
        entity.start_times[self.name] = start_time

        duration = random.expovariate(1.0 / self.processing_time)
        yield self.env.timeout(duration)

        end_time = self.env.now
        entity.end_times[self.name] = end_time
        stats.total_processing_time += (end_time - start_time)

        for component in self.next_components:
            yield from component.process(entity, stats)


class Exit:
    """Exit point — records entity completion."""

    def __init__(self, name: str, env: Optional[simpy.Environment] = None):
        self.name = name
        self.env = env

    def process(self, entity: Entity, stats: SimulationStats):
        stats.completed_entities += 1
        return
        yield  # Make this a generator
