"""
Admin CLI: deactivate (ban) or re-activate a user account.

Usage:
    python -m backend.scripts.set_user_active <username> --deactivate
    python -m backend.scripts.set_user_active <username> --activate
"""
import sys

from backend.storage import SessionLocal
from backend.storage.models import User


def main():
    if len(sys.argv) < 3 or sys.argv[2] not in ("--activate", "--deactivate"):
        print(__doc__)
        sys.exit(1)

    username, arg = sys.argv[1], sys.argv[2]
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.username == username).first()
        if user is None:
            print(f"No such user: {username}")
            sys.exit(1)

        user.is_active = arg == "--activate"
        print(f"{username}: {'activated' if user.is_active else 'deactivated'}")
        db.commit()
    finally:
        db.close()


if __name__ == "__main__":
    main()
