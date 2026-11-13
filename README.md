# VMS+

> **Feedback welcome.** Feedback and feature requests are welcome: [open an issue](../../issues) or contact me directly. Don't worry about feeling nitpicky: small quality-of-life improvements are the whole point. The only thing I won't add is a feature that only applies to a single event or individual person's workflow.

**A faster way to staff FIRST events in VMS.** VMS+ is a Chrome extension that adds a dashboard on top of FIRST's Volunteer Management System (`my.firstinspires.org/VMS`). It puts all your events side by side and lets you assign, check and contact volunteers in bulk.

In VMS itself you staff one event and one role at a time. You open each role's page, scroll through applicants, and check ages and clearances person by person. If you run a weekend with two or more events, you do all of that again for each one. VMS+ brings the whole weekend into one screen.

> Screenshots use made-up events and volunteers.

## What it does

### Staff several events at once

Pick a role and see who is in it on each day, how many slots are open, and who applied. One click assigns someone to one day or to all of them.

![Staffing tab: the Judge role across two events, with open slots, staged assignments and age warnings](docs/staffing.png)

- **Age checks for every role.** VMS+ knows FIRST's recommended minimum age for each role in each program (FLL, FTC, FRC), shown as a badge next to the role. Anyone under it is marked before you assign them.
- **Youth Protection.** People who haven't cleared Youth Protection screening are shown but can't be assigned.
- **Nothing changes until you confirm.** Assignments are *staged* first and shown as `+`. You review the list, then apply them all at once. Your staged changes survive a page reload.
- **Applicant tools.** Search by name, show people who applied for other roles or are already assigned elsewhere, and hide applicants who aren't a fit (VMS doesn't tell them).

### See where every event stands

The Roles tab shows each role's assigned / target count for every event. Short roles are yellow and full roles are green, with key roles first.

![Roles tab: assigned versus target for each role across two events](docs/roles.png)

- **Edit targets** inline, or copy them from one event to another.
- **Add a custom role** to several events at once.
- **Stop or reopen applications** for a role.
- **Copy invite links.** One click copies a role's or event's Express Volunteer link, or its QR code as an image, ready to paste into an email or a flyer.

### Know your volunteers

The People tab lists everyone across the loaded events, with what they're doing each day and flags for anything that needs attention.

![People tab: each volunteer's role and shift per event, with flags such as Minor, Not notified and Consent not signed](docs/people.png)

- **Flags:** needs clearance, minor, not notified, no shift set, training incomplete, consent not signed, assigned some days only, role differs by day, and here last season.
- **Filter and export.** Filter by status or role, copy everyone's emails for a BCC, download the roster, or copy it straight into Google Sheets.
- **Reminder drafts.** One click opens a Gmail draft for each person who still owes clearance, training or the consent form. You review and send them yourself.
- **Volunteer details.** Click a name to see their other applications, past seasons and coordinator comments.

### Bulk actions

- **Shift times:** set one shift time per event, or per role, and apply it to every assigned shift. This replaces VMS's 6am–10pm default.
- **Notify:** send the standard VMS assignment email to everyone you've assigned, across all events, in one go.
- **Message:** email everyone in chosen roles and events by status: notified, tentative, unassigned applicants, or everyone.

## Typical weekend

1. Open any VMS page, click **VMS+**, tick the weekend's events and press **Load**.
2. **Roles:** see which roles are short. Copy invite links for those roles and send them out.
3. **Staffing:** go role by role and stage assignments for each day. Age and clearance problems are flagged as you go.
4. **Shift times:** set the day's shift times.
5. **Notify:** review the list and send the assignment emails.
6. **People:** check the flags and send reminder drafts to anyone still missing clearance or training.

## Safe by design

- **Read-only until you confirm.** Loading only reads from VMS. Every change (assigning, targets, emails) is shown as a preview first and happens only when you confirm it.
- **It uses your own VMS login.** VMS+ can only see and do what your VMS account already can.
- **No servers.** Everything runs in your browser. Nothing is sent anywhere except VMS itself and the Gmail drafts you choose to open. Volunteer details stay in memory. The browser saves only your settings and staged changes, stored as ID numbers without names or emails.
- **Gentle on VMS.** VMS+ limits how fast it sends requests, retries when VMS is slow, and pauses if VMS asks it to back off.

## Install

1. Download the latest `vms-plus-<version>.zip` from [Releases](../../releases)
2. Unzip the download.
3. Open `chrome://extensions` and turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the unzipped folder.
5. Open any page on `my.firstinspires.org/VMS` and click the **VMS+** button.

To update, replace the folder's files with the new version and click the reload icon on the VMS+ card in `chrome://extensions`.

## Files

- `manifest.json`: the extension manifest (Manifest V3)
- `content.js`: the dashboard, which runs on VMS pages
- `background.js`: opens Gmail drafts and VMS pages in background tabs
- `docs/`: README screenshots
