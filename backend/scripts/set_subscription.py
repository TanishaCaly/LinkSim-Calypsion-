"""
Admin CLI: set or extend a user's subscription end date.

Usage:
    python -m backend.scripts.set_subscription <username> <days_from_today>
    python -m backend.scripts.set_subscription <username> --clear   (no expiry)
    python -m backend.scripts.set_subscription <username> --deactivate
    python -m backend.scripts.set_subscription <username> --activate
"""
import sys
from datetime import datetime, timedelta

from backend.storage import SessionLocal
from backend.storage.models import User


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    username, arg = sys.argv[1], sys.argv[2]
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.username == username).first()
        if user is None:
            print(f"No such user: {username}")
            sys.exit(1)

        if arg == "--clear":
            user.subscription_end_date = None
            print(f"{username}: subscription set to no-expiry")
        elif arg == "--deactivate":
            user.is_active = False
            print(f"{username}: deactivated")
        elif arg == "--activate":
            user.is_active = True
            print(f"{username}: activated")
        else:
            days = int(arg)
            user.subscription_end_date = datetime.utcnow() + timedelta(days=days)
            print(f"{username}: subscription_end_date set to {user.subscription_end_date.isoformat()}")

        db.commit()
    finally:
        db.close()


if __name__ == "__main__":
    main()
