"""One invented submission: a Client sends one finished-product Sample in containers.

Every name, address, code and Lot number comes from the pools below or from
`random.Random(seed)`. Nothing here is real.
"""

import random
from dataclasses import asdict, dataclass
from datetime import date, datetime, time, timedelta
from typing import Any

from synth.lab import DOCUMENT_REVISION, LAB_STAFF
from synth.tat import TAT_CODES, TatClass

# (company, brand, Product Code prefix, city line). Invented Clients.
CLIENTS: tuple[tuple[str, str, str, str], ...] = (
    ("Corvane Nutrition Co.", "Corvane", "CVN", "Tarrowfield, PA 19999"),
    ("Tallowby Botanicals LLC", "Tallowby", "TLB", "Orrin Bay, NY 14999"),
    ("Marrowgate Health Inc.", "Marrowgate", "MGH", "Ashcombe Ridge, NJ 08999"),
    ("Pellucine Supplements Ltd.", "Pellucine", "PLS", "Westhallow, CT 06999"),
    ("Fernhollow Naturals Inc.", "Fernhollow", "FHN", "Lindqvist Park, DE 19998"),
    ("Quistral Wellness Co.", "Quistral", "QWC", "Velmora Heights, NJ 07998"),
)

STREETS = ("Larkspur Way", "Quarry Hill Road", "Tamsin Lane", "Juniper Mill Drive")
FIRST_NAMES = ("Maren", "Idris", "Calla", "Tobiah", "Senna", "Anselm", "Delphine")
LAST_NAMES = ("Halloway", "Brisk", "Thorne-Ames", "Vantongeren", "Quell", "Lindgard")

PRODUCTS = (
    "Magnesium Glycinate 200 mg Capsules",
    "Elderberry Extract 300 mg Capsules",
    "Ashwagandha Root 450 mg Capsules",
    "Turmeric Root 500 mg Capsules",
    "Zinc Picolinate 30 mg Capsules",
    "Milk Thistle 250 mg Capsules",
)
PACK_COUNTS = (30, 60, 90, 120)
PACK_CONTAINERS = ("HDPE bottle", "amber glass bottle", "PET bottle")

SAMPLE_TYPE = "FP"  # finished product: the toy workflow weighs capsules
TEST_REQUESTED = "Average capsule weight"


@dataclass(frozen=True)
class Party:
    company: str
    contact: str
    street: str
    city: str
    phone: str
    email: str


@dataclass(frozen=True)
class Container:
    number: int
    qty_received: int


@dataclass(frozen=True)
class Weighing:
    container: int
    weight_of_20_capsules_g: float
    weight_taken_g: float

    @property
    def average_weight_g(self) -> float:
        return self.weight_of_20_capsules_g / 20


@dataclass(frozen=True)
class Record:
    seed: int
    lab_reference: str
    submitter: Party
    bill_to: Party
    report_to: Party
    product_name: str
    product_code: str
    product_type: str
    sample_type: str
    lot: str
    tat_code: str
    submitted_on: date
    received_on: date
    received_at: time
    received_by: str
    expires_on: date
    containers: tuple[Container, ...]
    weighings: tuple[Weighing, ...]
    analyst: str
    reviewer: str
    approver: str
    document_revision: str

    @property
    def client(self) -> str:
        return self.submitter.company

    @property
    def tat_class(self) -> TatClass:
        return TAT_CODES[self.tat_code]

    @property
    def document_time(self) -> datetime:
        """The fixed timestamp written into every document's metadata."""
        return datetime.combine(self.received_on, time(8, 0))

    @property
    def mean_average_weight_g(self) -> float:
        return sum(w.average_weight_g for w in self.weighings) / len(self.weighings)

    def manifest(self) -> dict[str, Any]:
        return {
            "seed": self.seed,
            "lab_reference": self.lab_reference,
            "client": self.client,
            "submitter": asdict(self.submitter),
            "bill_to": asdict(self.bill_to),
            "report_to": asdict(self.report_to),
            "product_name": self.product_name,
            "product_code": self.product_code,
            "product_type": self.product_type,
            "sample_type": self.sample_type,
            "lot": self.lot,
            "tat_code": self.tat_code,
            "tat_class": str(self.tat_class),
            "submitted_on": self.submitted_on.isoformat(),
            "received_on": self.received_on.isoformat(),
            "received_at": self.received_at.strftime("%H:%M"),
            "received_by": self.received_by,
            "expires_on": self.expires_on.isoformat(),
            "containers": [asdict(c) for c in self.containers],
            "weighings": [asdict(w) for w in self.weighings],
            "analyst": self.analyst,
            "reviewer": self.reviewer,
            "approver": self.approver,
            "document_revision": self.document_revision,
        }


def invent_record(seed: int) -> Record:
    rng = random.Random(seed)
    company, brand, code_prefix, city = rng.choice(CLIENTS)
    domain = f"{brand.lower()}.example"

    def party(company_name: str) -> Party:
        first, last = rng.choice(FIRST_NAMES), rng.choice(LAST_NAMES)
        return Party(
            company=company_name,
            contact=f"{first} {last}",
            street=f"{rng.randint(10, 990)} {rng.choice(STREETS)}",
            city=city,
            phone=f"(201) 555-01{rng.randint(10, 99)}",
            email=f"{first.lower()}.{last.lower()}@{domain}",
        )

    submitter = party(company)
    bill_to = party(company)
    report_to = party(company)

    received_on = date(2026, 1, 5) + timedelta(days=rng.randint(0, 300))
    if received_on.weekday() >= 5:
        received_on += timedelta(days=7 - received_on.weekday())
    submitted_on = received_on - timedelta(days=rng.randint(1, 3))
    received_at = time(rng.randint(8, 16), rng.randint(0, 59))
    expires_on = date(received_on.year + rng.randint(1, 3), rng.randint(1, 12), 1)

    staff = rng.sample(LAB_STAFF, 4)
    received_by = staff[0][1]

    containers = tuple(Container(n, 1) for n in range(1, rng.randint(2, 4) + 1))
    capsule_g = rng.uniform(0.35, 0.85)
    weighings = tuple(
        Weighing(
            container=c.number,
            weight_of_20_capsules_g=round(20 * capsule_g * rng.gauss(1, 0.01), 4),
            weight_taken_g=round(capsule_g * rng.uniform(0.9, 1.1), 4),
        )
        for c in containers
    )

    return Record(
        seed=seed,
        lab_reference=f"LR-{received_on.year}-{rng.randint(1, 9999):04d}",
        submitter=submitter,
        bill_to=bill_to,
        report_to=report_to,
        product_name=f"{brand} {rng.choice(PRODUCTS)}",
        product_code=f"{code_prefix}-{rng.randint(1000, 9999)}",
        product_type=f"{rng.choice(PACK_COUNTS)} ct {rng.choice(PACK_CONTAINERS)}",
        sample_type=SAMPLE_TYPE,
        lot=f"LT-{received_on.year % 100:02d}{rng.randint(0, 9999):04d}",
        tat_code=rng.choice(sorted(TAT_CODES)),
        submitted_on=submitted_on,
        received_on=received_on,
        received_at=received_at,
        received_by=received_by,
        expires_on=expires_on,
        containers=containers,
        weighings=weighings,
        analyst=staff[1][0],
        reviewer=staff[2][0],
        approver=staff[3][0],
        document_revision=DOCUMENT_REVISION,
    )
