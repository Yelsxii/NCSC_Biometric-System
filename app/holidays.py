"""Verified PH national non-working dates. No employee data leaves the host.

Coverage: 2025/2026, verified 2026-11-24. Special WORKING days are excluded.
Office calendar overrides retain precedence. Unlisted years are not guessed.
"""
VERIFIED_YEARS = {2025, 2026}
SOURCES = {
    '2025': 'https://pco.gov.ph/news_releases/pbbm-issues-proclamation-declaring-regular-holidays-special-non-working-days-for-2025/',
    '2026': 'https://pco.gov.ph/wp-content/uploads/2025/09/20250903-PROC-1006-FRM.pdf.pdf',
    '2025-fitr': 'https://pco.gov.ph/news_releases/pbbm-declares-april-1-a-regular-holiday-to-mark-eidl-fitr/',
    '2025-adha': 'https://pco.gov.ph/news_releases/pbbm-declares-june-6-regular-holiday-for-eidl-adha-observance/',
    '2025-election': 'https://pco.gov.ph/news_releases/proclamation-no-878-declaring-monday-12-may-2025-a-special-non-working-holiday-throughout-the-country/',
    '2026-fitr': 'https://pco.gov.ph/news_releases/palace-declares-march-20-regular-holiday-nationwide-for-eidl-fitr/',
    '2026-adha': 'https://pco.gov.ph/news_releases/palace-declares-may-27-as-a-regular-holiday-for-eidl-adha-observance/',
}
DATES = {
    '2025-01-01': "New Year's Day", '2025-01-29': 'Chinese New Year',
    '2025-04-01': "Eid'l Fitr", '2025-04-09': 'Araw ng Kagitingan',
    '2025-04-17': 'Maundy Thursday', '2025-04-18': 'Good Friday', '2025-04-19': 'Black Saturday',
    '2025-05-01': 'Labor Day', '2025-05-12': 'National and local elections',
    '2025-06-06': "Eid'l Adha", '2025-06-12': 'Independence Day',
    '2025-08-21': 'Ninoy Aquino Day', '2025-08-25': 'National Heroes Day',
    '2025-10-31': "All Saints' Day Eve", '2025-11-01': "All Saints' Day", '2025-11-30': 'Bonifacio Day',
    '2025-12-08': 'Immaculate Conception', '2025-12-24': 'Christmas Eve',
    '2025-12-25': 'Christmas Day', '2025-12-30': 'Rizal Day', '2025-12-31': 'Last day of the year',
    '2026-01-01': "New Year's Day", '2026-02-17': 'Chinese New Year', '2026-03-20': "Eid'l Fitr",
    '2026-04-02': 'Maundy Thursday', '2026-04-03': 'Good Friday', '2026-04-04': 'Black Saturday',
    '2026-04-09': 'Araw ng Kagitingan', '2026-05-01': 'Labor Day', '2026-05-27': "Eid'l Adha",
    '2026-06-12': 'Independence Day', '2026-08-21': 'Ninoy Aquino Day', '2026-08-31': 'National Heroes Day',
    '2026-11-01': "All Saints' Day", '2026-11-02': "All Souls' Day", '2026-11-30': 'Bonifacio Day',
    '2026-12-08': 'Immaculate Conception', '2026-12-24': 'Christmas Eve',
    '2026-12-25': 'Christmas Day', '2026-12-30': 'Rizal Day', '2026-12-31': 'Last day of the year',
}


def national_holiday(date):
    return DATES.get(date, '')
