› Design a spec for converting this from local 1-person only mapping/data bathymetry plugin to ingesting data from many people that have
  this plugin. Users will need to approve sharing their data, in order to be able to pull down and
  use peer data and possibly more advanced capabilities?

# Design

## Architecture

## Principles
  - Easy to use and understand for end-user
  - Work should be done locally and then uploaded and verified
  - Calculations from a source that failed validations results in those being marked un-usable
  - Use s3 for nearly everything, keep actual service very light/minimal
  - Cache heavily
  - Transparency of data and how its used
  - Reproducible data
  - Data enables worldwide scientific usage

## Offline Mode
  - Offline mode uses local data
  - Stores local data up to some limit
  - When online again, uploads data from last upload, or from oldest available record
    - Maybe records should be signed when first persisted?
    - Users sign their upload data with their own signature that combines a per-install key and a
    nonce


It must be able to operate smoothly offline and could buffer downsampled data for a period of N-measurements and
supply them to cloud when back online. That should default to 50MB of data and be very compact with a config value
to override... should it be the same config and storage as our other part and the only difference is there's a
cursor stored for what was last uploaded, eg where to start next upload?

Could we keep it so that upload only happens when someone has enough local data to warrant it AND we drop it
directly from them to S3 as parquet in s3 express via pre-signed link in their own subdirectory? Then we do batch/
streaming jobs to transform it? That would save us from having to have an intake pipeline from the users and be
highly reliable since we just need to handout s3 upload pre-signs. The plugin should use local state to instantly
reflect it for the user, but we can background process to transform that for others.
try again

For pre-signs, we need to consider abuse... so rate limiting the handout of keys and limiting the
scope of keys to subdirectory of that user. Also rate limiting should allow for shadow banning and
full banning... must log ip addresses to help watch out for mis-use.

Opportunity to have them pre-calculate as much sampling as possible for the upload to avoid having a
free service paying high hardware costs. Long term if cost becomes a problem, we could split the
calculation load like a bit-torrent where we send it out to multiple parties and verify we get the
identical result.



# Challenges

Data quality will be a problem because it's coming from a wide variety of hardware installed by a
wide variety of humans. Problems with involved signals being incorrect due to no calibrations,
     incorrect calibrations, or bad hardware in depth/location/time will require mitigations.

We can implement quality with different guardrails:
1. If we have correct sensors and calibrations in multiple boards, those are high trust
2. If we have readings that are very close for charts then it's higher trust
3. Web of Trust by thumbsupping/downing other boat measurements could give some indication
4. Tidal change being mirrored by measurement change at least indicates the depth sensor is
   internally consistent even if placement is incorrect/calibration is incorrect.

  The complexity is going to be in data quality because for random users who provide data we
  redistribute, we cannot know their actual calibrated depths... ie where is transducer placed, how far below
  waterline. The spec should cover the design of gathering their data, then trying to pre-process their data on their
  own boat to add adjustments to be standardized... then on serverside we validated a sampling of data for correct
  calculations and quauarantine boats sending bad data (shadow ban except back to them). We will need to store the
  data in hot/cool storage ourselves, so layout that plan and datasize and aggregation levels... maybe a bulk s3
  parquet and materialized data that lives in a cached layer for fetching... maybe redis with s3 backing.


# Data Privacy

Create unique nonce for each user/installation and keep that tied to data. Only retain identifiable
ip addresses and location as necessary for the functionality and the auditability for abuse.

Have disclaimer and make sure we're GDPR/CCPA compliant
